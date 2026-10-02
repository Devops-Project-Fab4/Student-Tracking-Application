import math
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Attendance, AuditLog, ClassSession, FraudLog, SessionStudent, User


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def audit(db: Session, actor: int | None, action: str, detail: str):
    db.add(AuditLog(actor_id=actor, action=action, detail=detail))


def session_access(db: Session, session_id: int, user: User, lock=False):
    # A write lock serializes scans and headcount/review updates, including on SQLite.
    if lock:
        db.execute(update(ClassSession).where(ClassSession.id == session_id).values(closed=ClassSession.closed))
    session = db.get(ClassSession, session_id, populate_existing=True)
    if session is None:
        raise HTTPException(404, "Session not found")
    if user.role == "faculty" and session.faculty_id != user.id:
        raise HTTPException(403, "This session belongs to another faculty member")
    if user.role == "student" and db.get(SessionStudent, (session_id, user.id)) is None:
        raise HTTPException(403, "You are not enrolled in this session")
    return session


def reconcile(db: Session, session: ClassSession):
    rows = list(db.scalars(select(Attendance).where(Attendance.session_id == session.id).order_by(Attendance.timestamp, Attendance.id)))
    capacity = session.headcount if session.headcount is not None else 0
    # Reviewed approvals get priority, but never bypass headcount capacity.
    ordered = sorted(rows, key=lambda row: row.review_decision != "PRESENT")
    for row in ordered:
        if row.review_decision == "BLOCKED":
            row.status = "BLOCKED"
        elif row.risk_reason and row.review_decision != "PRESENT":
            row.status = "UNDER_REVIEW"
        elif capacity > 0:
            row.status = "PRESENT"
            capacity -= 1
        else:
            row.status = "UNDER_REVIEW"
    db.flush()
    return rows


def fraud(db: Session, session_id: int, student_id: int, kind: str, detail: str):
    db.add(FraudLog(session_id=session_id, student_id=student_id, kind=kind, detail=detail))


def distance_m(lat1, lon1, lat2, lon2):
    a, b = math.radians(lat1), math.radians(lat2)
    dlat, dlon = b - a, math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))