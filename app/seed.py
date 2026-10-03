"""Explicit, development-only seed: python -m app.seed."""
from datetime import timedelta

from sqlalchemy import select

from app.config import get_settings
from app.database import Base, SessionLocal, engine
from app.models import Attendance, ClassSession, Course, SessionStudent, Student, User, utcnow
from app.security import digest, passwords
from app.services import fraud, reconcile


def main():
    if get_settings().environment == "production":
        raise SystemExit("Demo seeding is disabled in production")
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)):
            raise SystemExit("Database already contains users; demo seed requires an empty database")
        hashed = passwords.hash("AttendlyDemo!2026")
        admin = User(name="Alex Morgan", email="admin@example.com", password_hash=hashed, role="admin")
        faculty = User(name="Dr. Sarah Mitchell", email="faculty@example.com", password_hash=hashed, role="faculty")
        db.add_all([admin, faculty])
        db.flush()
        names = ["Aarav Sharma", "Olivia Bennett", "Liam Carter", "Emma Wilson", "Noah Williams", "Sophia Davis", "Arjun Patel", "Isabella Martin", "Ethan Brooks", "Mia Anderson", "Lucas Thomas", "Amelia Clark", "Rohan Mehta", "Charlotte Lewis", "James Walker", "Harper Hall", "Benjamin Allen", "Evelyn Young", "Aditya Singh", "Abigail King"]
        students = []
        for number in range(1, 61):
            name = names[number - 1] if number <= len(names) else f"Demo Student {number:02d}"
            user = User(name=name, email=f"student{number:02d}@example.com", password_hash=hashed, role="student")
            db.add(user)
            db.flush()
            db.add(Student(id=user.id, roll_number=f"CS-{number:03d}", department="Computer Science", semester=4))
            students.append(user)
        course = Course(code="CS204", name="Database Management Systems", faculty_id=faculty.id, department="Computer Science", semester=4)
        db.add(course)
        db.add(Course(code="CS206", name="Computer Networks", faculty_id=faculty.id, department="Computer Science", semester=4))
        db.flush()
        now = utcnow()
        session = ClassSession(course_id=course.id, faculty_id=faculty.id, starts_at=now - timedelta(minutes=15), ends_at=now + timedelta(hours=4), headcount=55)
        db.add(session)
        db.flush()
        for user in students:
            db.add(SessionStudent(session_id=session.id, student_id=user.id))
        for index, user in enumerate(students[:57]):
            db.add(Attendance(student_id=user.id, session_id=session.id, timestamp=now - timedelta(minutes=10) + timedelta(seconds=index), device_id=digest(f"demo-device-{index}"), ip_address="127.0.0.1"))
        db.flush()
        reconcile(db, session)
        for user in students[55:57]:
            fraud(db, session.id, user.id, "EXCESS_ATTENDANCE", "57 QR responses exceed the entered headcount of 55")
        db.commit()
    print("Demo ready: 60 students, headcount 55, responses 57, present 55, under review 2.")
    print("Accounts: admin@example.com / faculty@example.com / student60@example.com")
    print("Development-only password: AttendlyDemo!2026")


if __name__ == "__main__":
    main()