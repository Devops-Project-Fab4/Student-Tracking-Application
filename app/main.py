import base64
import csv
import io
import secrets
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import qrcode
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, SessionLocal, engine, get_db
from app.models import (
    Attendance,
    AuditLog,
    ClassSession,
    Course,
    FraudLog,
    LoginAttempt,
    SessionStudent,
    Student,
    User,
    utcnow,
)
from app.schemas import (
    CourseInput,
    HeadcountInput,
    LoginInput,
    ReviewInput,
    ScanInput,
    SessionInput,
    StudentUpdate,
    UserInput,
)
from app.security import DUMMY_HASH, current_user, digest, make_token, passwords, require_admin, require_staff
from app.services import audit, aware, distance_m, fraud, reconcile, session_access

settings = get_settings()
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_app):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if settings.bootstrap_admin_email and not db.scalar(select(User).where(User.role == "admin")):
            if len(settings.bootstrap_admin_password) < 12:
                raise RuntimeError("BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters")
            db.add(User(name="Administrator", email=settings.bootstrap_admin_email.lower(), password_hash=passwords.hash(settings.bootstrap_admin_password), role="admin"))
            audit(db, None, "BOOTSTRAP_ADMIN", "Initial administrator created")
            db.commit()
    yield


app = FastAPI(title="Attendly • Student Attendance", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        configured = urlsplit(settings.public_url)
        allowed_origin = f"{configured.scheme}://{configured.netloc}"
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != allowed_origin):
            return JSONResponse({"detail": "Cross-origin writes are not permitted"}, status_code=403)
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"detail": "Use application/json"}, status_code=415)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(self), geolocation=(self)"
    response.headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.url.path in ("/docs", "/redoc"):
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://fastapi.tiangolo.com; worker-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    if settings.cookie_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.exception_handler(IntegrityError)
async def integrity_error(_request, _exc):
    return JSONResponse({"detail": "A record with these unique details already exists"}, status_code=409)


def user_data(user):
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role, "active": user.active}


def course_data(db, course):
    faculty = db.get(User, course.faculty_id)
    return {"id": course.id, "code": course.code, "name": course.name, "faculty_id": course.faculty_id, "faculty_name": faculty.name, "department": course.department, "semester": course.semester, "active": course.active}


def session_data(db, session):
    course = db.get(Course, session.course_id)
    faculty = db.get(User, session.faculty_id)
    strength = db.execute(select(func.count()).select_from(SessionStudent).where(SessionStudent.session_id == session.id)).scalar_one()
    rows = list(db.scalars(select(Attendance).where(Attendance.session_id == session.id)))
    present = sum(row.status == "PRESENT" for row in rows)
    suspicious = sum(row.status == "UNDER_REVIEW" for row in rows)
    return {"id": session.id, "subject": course.name, "course_code": course.code, "faculty_name": faculty.name, "starts_at": aware(session.starts_at), "ends_at": aware(session.ends_at), "headcount": session.headcount, "closed": session.closed, "class_strength": strength, "responses": len(rows), "valid": present, "suspicious": suspicious, "absent": strength - present - suspicious, "excess": max(0, len(rows) - session.headcount) if session.headcount is not None else 0, "geofenced": session.radius_m is not None, "qr_expires": aware(session.qr_expires) if session.qr_expires else None}


def visible_sessions(db, user):
    query = select(ClassSession).order_by(ClassSession.starts_at.desc())
    if user.role == "faculty":
        query = query.where(ClassSession.faculty_id == user.id)
    elif user.role == "student":
        query = query.join(SessionStudent).where(SessionStudent.student_id == user.id)
    return list(db.scalars(query))


def attendance_data(db, session, only_student=None):
    query = select(Student, User).join(User, User.id == Student.id).join(SessionStudent, SessionStudent.student_id == Student.id).where(SessionStudent.session_id == session.id).order_by(Student.roll_number)
    if only_student:
        query = query.where(Student.id == only_student)
    records = {row.student_id: row for row in db.scalars(select(Attendance).where(Attendance.session_id == session.id))}
    result = []
    for student, user in db.execute(query):
        row = records.get(student.id)
        reason = ""
        if row:
            reason = row.risk_reason
            if row.status == "UNDER_REVIEW" and not reason:
                reason = "Awaiting headcount" if session.headcount is None else "Headcount capacity exceeded"
        result.append({"id": row.id if row else None, "student_id": student.id, "name": user.name, "roll_number": student.roll_number, "status": row.status if row else "ABSENT", "timestamp": aware(row.timestamp) if row else None, "reason": reason, "review_decision": row.review_decision if row else None})
    return result


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(data: LoginInput, request: Request, response: Response, db: Session = Depends(get_db)):
    email = data.email.lower()
    # Shared database limiter works across workers; forwarded IP headers are not trusted.
    keys = [digest("email:" + email), digest("ip:" + (request.client.host if request.client else "unknown"))]
    cutoff = utcnow() - timedelta(minutes=15)
    db.execute(delete(LoginAttempt).where(LoginAttempt.timestamp < cutoff))
    for key, limit in zip(keys, (10, 100)):
        if db.execute(select(func.count()).select_from(LoginAttempt).where(LoginAttempt.key == key, LoginAttempt.timestamp >= cutoff)).scalar_one() >= limit:
            raise HTTPException(429, "Too many sign-in attempts. Try again in 15 minutes.")
    user = db.scalar(select(User).where(User.email == email))
    valid = passwords.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid or not user.active:
        for key in keys:
            db.add(LoginAttempt(key=key))
        audit(db, None, "LOGIN_FAILED", "Invalid sign-in attempt")
        db.commit()
        raise HTTPException(401, "Invalid email or password")
    db.execute(delete(LoginAttempt).where(LoginAttempt.key == keys[0]))
    audit(db, user.id, "LOGIN", "Successful sign-in")
    db.commit()
    response.set_cookie("attendance_token", make_token(user), httponly=True, secure=settings.cookie_secure, samesite="strict", max_age=8 * 3600, path="/")
    return user_data(user)


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("attendance_token", path="/", secure=settings.cookie_secure, httponly=True, samesite="strict")
    return {"message": "Signed out"}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)):
    return user_data(user)


@app.get("/api/users")
def users(_user: User = Depends(require_admin), db: Session = Depends(get_db)):
    result = []
    for user in db.scalars(select(User).order_by(User.name)):
        item = user_data(user)
        student = db.get(Student, user.id)
        if student:
            item.update(roll_number=student.roll_number, department=student.department, semester=student.semester)
        result.append(item)
    return result


@app.post("/api/users", status_code=201)
def create_user(data: UserInput, actor: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = User(name=data.name.strip(), email=data.email.lower(), password_hash=passwords.hash(data.password), role=data.role)
    db.add(user)
    db.flush()
    if data.role == "student":
        db.add(Student(id=user.id, roll_number=data.roll_number.strip(), department=data.department.strip(), semester=data.semester))
    audit(db, actor.id, "CREATE_USER", f"Created {data.role} #{user.id}")
    db.commit()
    return user_data(user)


@app.put("/api/students/{student_id}")
def update_student(student_id: int, data: StudentUpdate, actor: User = Depends(require_admin), db: Session = Depends(get_db)):
    student, user = db.get(Student, student_id), db.get(User, student_id)
    if not student or not user:
        raise HTTPException(404, "Student not found")
    user.name, user.email, user.active = data.name.strip(), data.email.lower(), data.active
    student.roll_number, student.department, student.semester = data.roll_number.strip(), data.department.strip(), data.semester
    audit(db, actor.id, "UPDATE_STUDENT", f"Updated student #{student_id}, active={data.active}")
    db.commit()
    return user_data(user)


@app.get("/api/courses")
def courses(user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(Course).order_by(Course.code)
    if user.role == "faculty":
        query = query.where(Course.faculty_id == user.id)
    elif user.role == "student":
        student = db.get(Student, user.id)
        if student is None:
            raise HTTPException(409, "Student profile is missing; contact your administrator")
        query = query.where(Course.department == student.department, Course.semester == student.semester, Course.active.is_(True))
    return [course_data(db, course) for course in db.scalars(query)]


def validate_faculty(db, faculty_id):
    faculty = db.get(User, faculty_id)
    if not faculty or faculty.role != "faculty" or not faculty.active:
        raise HTTPException(422, "Select an active faculty member")


@app.post("/api/courses", status_code=201)
def create_course(data: CourseInput, actor: User = Depends(require_admin), db: Session = Depends(get_db)):
    validate_faculty(db, data.faculty_id)
    course = Course(**data.model_dump())
    db.add(course)
    db.flush()
    audit(db, actor.id, "CREATE_COURSE", f"Created course #{course.id}")
    db.commit()
    return course_data(db, course)


@app.put("/api/courses/{course_id}")
def update_course(course_id: int, data: CourseInput, actor: User = Depends(require_admin), db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    validate_faculty(db, data.faculty_id)
    for field, value in data.model_dump().items():
        setattr(course, field, value)
    audit(db, actor.id, "UPDATE_COURSE", f"Updated course #{course.id}")
    db.commit()
    return course_data(db, course)


@app.get("/api/sessions")
def sessions(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [session_data(db, session) for session in visible_sessions(db, user)]


@app.post("/api/sessions", status_code=201)
def create_session(data: SessionInput, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    course = db.get(Course, data.course_id)
    if not course or not course.active:
        raise HTTPException(404, "Active course not found")
    if user.role == "faculty" and course.faculty_id != user.id:
        raise HTTPException(403, "This course belongs to another faculty member")
    session = ClassSession(**data.model_dump(), faculty_id=course.faculty_id)
    db.add(session)
    db.flush()
    roster = db.scalars(select(Student.id).join(User, User.id == Student.id).where(Student.department == course.department, Student.semester == course.semester, User.active.is_(True)))
    for student_id in roster:
        db.add(SessionStudent(session_id=session.id, student_id=student_id))
    audit(db, user.id, "CREATE_SESSION", f"Created session #{session.id}")
    db.commit()
    return session_data(db, session)


@app.get("/api/sessions/{session_id}")
def session_detail(session_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    session = session_access(db, session_id, user)
    return {**session_data(db, session), "attendance": attendance_data(db, session, user.id if user.role == "student" else None)}


@app.put("/api/sessions/{session_id}/headcount")
def headcount(session_id: int, data: HeadcountInput, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    session = session_access(db, session_id, user, lock=True)
    strength = db.execute(select(func.count()).select_from(SessionStudent).where(SessionStudent.session_id == session_id)).scalar_one()
    if data.headcount > strength:
        raise HTTPException(422, "Headcount cannot exceed the session roster")
    session.headcount = data.headcount
    rows = reconcile(db, session)
    extra = max(0, len(rows) - data.headcount)
    if extra:
        for row in rows:
            if row.status == "UNDER_REVIEW":
                fraud(db, session_id, row.student_id, "EXCESS_ATTENDANCE", f"Reconciliation found {extra} excess responses")
    audit(db, user.id, "SET_HEADCOUNT", f"Session #{session_id}: {data.headcount}")
    db.commit()
    return session_data(db, session)


@app.post("/api/sessions/{session_id}/close")
def close_session(session_id: int, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    session = session_access(db, session_id, user, lock=True)
    if session.headcount is None:
        raise HTTPException(422, "Enter the actual headcount before closing")
    session.closed, session.qr_hash = True, None
    reconcile(db, session)
    audit(db, user.id, "CLOSE_SESSION", f"Closed session #{session_id}")
    db.commit()
    return session_data(db, session)


@app.post("/api/sessions/{session_id}/qr")
def generate_qr(session_id: int, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    session = session_access(db, session_id, user, lock=True)
    now = utcnow()
    if session.closed or not aware(session.starts_at) <= now < aware(session.ends_at):
        raise HTTPException(409, "QR generation is available only during an open class session")
    token = secrets.token_urlsafe(32)
    session.qr_hash = digest(token)
    session.qr_expires = min(now + timedelta(minutes=5), aware(session.ends_at))
    # Fragment keeps the secret out of access logs and HTTP referrers.
    url = settings.public_url.rstrip("/") + "/#" + urlencode({"session": session_id, "token": token})
    buffer = io.BytesIO()
    qrcode.make(url).save(buffer)
    audit(db, user.id, "ROTATE_QR", f"Rotated QR for session #{session_id}")
    db.commit()
    return {"url": url, "expires_at": aware(session.qr_expires), "image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}


@app.post("/api/attendance/scan", status_code=201)
def scan(data: ScanInput, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.role != "student":
        raise HTTPException(403, "Only students can submit attendance")
    session = session_access(db, data.session_id, user, lock=True)
    now = utcnow()
    valid = (not session.closed and aware(session.starts_at) <= now < aware(session.ends_at) and session.qr_hash and secrets.compare_digest(session.qr_hash, digest(data.token)) and session.qr_expires and now < aware(session.qr_expires))
    if not valid:
        fraud(db, session.id, user.id, "INVALID_QR", "Expired, rotated, invalid QR or session not open")
        db.commit()
        raise HTTPException(400, "INVALID_QR: this QR is expired or the session is not open")
    device = digest(data.device_id)
    previous = db.scalar(select(Attendance).where(Attendance.session_id == session.id, Attendance.student_id == user.id))
    if previous:
        kind = "MULTI_DEVICE" if previous.device_id != device else "DUPLICATE"
        fraud(db, session.id, user.id, kind, "Repeat redemption from a different device" if kind == "MULTI_DEVICE" else "Repeat redemption on the same device")
        if kind == "MULTI_DEVICE":
            previous.risk_reason = "Multiple devices used for this student"
            previous.review_decision = None
            reconcile(db, session)
        db.commit()
        raise HTTPException(409, f"{kind}: attendance has already been submitted")
    reasons = []
    shared = list(db.scalars(select(Attendance).where(Attendance.session_id == session.id, Attendance.device_id == device)))
    if shared:
        reasons.append("Device shared with another student")
        for prior in shared:
            prior.risk_reason = "Device shared with another student"
            prior.review_decision = None
            fraud(db, session.id, prior.student_id, "SHARED_DEVICE", "Device used by multiple students; manual review required")
        fraud(db, session.id, user.id, "SHARED_DEVICE", "Device used by multiple students; manual review required")
    if session.radius_m is not None:
        if data.latitude is None or data.longitude is None:
            reasons.append("Classroom location was not supplied")
        elif distance_m(session.latitude, session.longitude, data.latitude, data.longitude) > session.radius_m:
            reasons.append("Reported location is outside the classroom")
        if any("location" in reason for reason in reasons):
            fraud(db, session.id, user.id, "OUTSIDE_CLASSROOM", reasons[-1])
    row = Attendance(student_id=user.id, session_id=session.id, timestamp=now, device_id=device, ip_address=request.client.host if request.client else "unknown", latitude=data.latitude, longitude=data.longitude, risk_reason="; ".join(reasons))
    db.add(row)
    db.flush()
    rows = reconcile(db, session)
    if session.headcount is not None and len(rows) > session.headcount:
        fraud(db, session.id, user.id, "EXCESS_ATTENDANCE", "Response count exceeds the entered classroom headcount")
    audit(db, user.id, "SUBMIT_ATTENDANCE", f"Session #{session.id}: {row.status}")
    db.commit()
    return {"id": row.id, "status": row.status, "message": "Attendance recorded" if row.status == "PRESENT" else "Attendance submitted for faculty review"}


@app.put("/api/attendance/{attendance_id}/review")
def review(attendance_id: int, data: ReviewInput, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    row = db.get(Attendance, attendance_id)
    if row is None:
        raise HTTPException(404, "Attendance record not found")
    session = session_access(db, row.session_id, user, lock=True)
    db.refresh(row)
    if data.decision == "PRESENT":
        present = db.execute(select(func.count()).select_from(Attendance).where(Attendance.session_id == session.id, Attendance.status == "PRESENT", Attendance.id != row.id)).scalar_one()
        if session.headcount is None or present >= session.headcount:
            raise HTTPException(409, "No headcount capacity. Correct headcount or block an incorrect approval first.")
    row.review_decision = data.decision
    reconcile(db, session)
    audit(db, user.id, "REVIEW_ATTENDANCE", f"Record #{row.id}: {data.decision}. Reason: {data.reason}")
    db.commit()
    return {"status": row.status}


@app.get("/api/history")
def history(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.role != "student":
        raise HTTPException(403, "Student access required")
    return [{**session_data(db, session), "record": attendance_data(db, session, user.id)[0]} for session in visible_sessions(db, user)]


@app.get("/api/fraud-logs")
def fraud_logs(user: User = Depends(require_staff), db: Session = Depends(get_db)):
    query = select(FraudLog, User, Course).join(User, User.id == FraudLog.student_id).join(ClassSession, ClassSession.id == FraudLog.session_id).join(Course, Course.id == ClassSession.course_id)
    if user.role == "faculty":
        query = query.where(ClassSession.faculty_id == user.id)
    return [{"id": log.id, "session_id": log.session_id, "student_name": student.name, "kind": log.kind, "detail": log.detail, "timestamp": aware(log.timestamp), "subject": course.name} for log, student, course in db.execute(query.order_by(FraudLog.timestamp.desc()).limit(500))]


@app.get("/api/audit-logs")
def audit_logs(_user: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [{"id": row.id, "actor_id": row.actor_id, "action": row.action, "detail": row.detail, "timestamp": aware(row.timestamp)} for row in db.scalars(select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(500))]


def csv_cell(value):
    value = str(value if value is not None else "")
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value


@app.get("/api/reports")
def reports(period: str = Query(default="daily", pattern="^(daily|monthly|suspicious)$"), day: date = Query(default_factory=lambda: utcnow().date()), download: bool = False, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    start = datetime.combine(day.replace(day=1) if period == "monthly" else day, time.min, timezone.utc)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) if period == "monthly" else start + timedelta(days=1)
    selected = [session for session in visible_sessions(db, user) if start <= aware(session.starts_at) < end]
    result = []
    for session in selected:
        subject = db.execute(select(Course.name).where(Course.id == session.course_id)).scalar_one()
        for row in attendance_data(db, session):
            if period == "suspicious" and row["status"] not in ("UNDER_REVIEW", "BLOCKED"):
                continue
            result.append({"date": aware(session.starts_at).date().isoformat(), "session_id": session.id, "subject": subject, "roll_number": row["roll_number"], "student": row["name"], "status": row["status"], "reason": row["reason"]})
    if download:
        output = io.StringIO()
        fields = ["date", "session_id", "subject", "roll_number", "student", "status", "reason"]
        writer = csv.writer(output, quoting=csv.QUOTE_ALL)
        writer.writerow(fields)
        writer.writerows([csv_cell(row[field]) for field in fields] for row in result)
        return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="attendance-{period}-{day}.csv"'})
    return {"period": period, "from": start, "to": end, "rows": result}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")