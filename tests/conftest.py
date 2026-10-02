import os
from datetime import timedelta

# Set isolated configuration before importing the application.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "test-key-that-is-long-enough-for-hmac-signing"
os.environ["ENVIRONMENT"] = "development"
os.environ["COOKIE_SECURE"] = "false"
os.environ["PUBLIC_URL"] = "http://localhost:8000"
os.environ["BOOTSTRAP_ADMIN_EMAIL"] = ""
os.environ["BOOTSTRAP_ADMIN_PASSWORD"] = ""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import ClassSession, Course, SessionStudent, Student, User, utcnow
from app.security import make_token, passwords


@pytest.fixture
def world(tmp_path, monkeypatch):
    test_url = os.environ.get("TEST_DATABASE_URL")
    engine = create_engine(test_url or f"sqlite:///{tmp_path / 'test.db'}", connect_args={} if test_url else {"check_same_thread": False, "timeout": 30})
    # TEST_DATABASE_URL must be a dedicated disposable database, never the application database.
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    # Startup and requests must use the same isolated database.
    monkeypatch.setattr("app.main.engine", engine)
    monkeypatch.setattr("app.main.SessionLocal", factory)
    with factory() as db:
        hashed = passwords.hash("TestingPassword!2026")
        admin = User(name="Admin User", email="admin@example.com", role="admin", password_hash=hashed)
        faculty = User(name="Faculty User", email="faculty@example.com", role="faculty", password_hash=hashed)
        other = User(name="Other Faculty", email="other@example.com", role="faculty", password_hash=hashed)
        db.add_all([admin, faculty, other])
        db.flush()
        students = []
        for index in range(60):
            user = User(name=f"Student {index:02d}", email=f"student{index:02d}@example.com", role="student", password_hash=hashed)
            db.add(user)
            db.flush()
            db.add(Student(id=user.id, roll_number=f"CS-{index:03d}", department="Computer Science", semester=4))
            students.append(user)
        course = Course(code="CS204", name="Database Systems", faculty_id=faculty.id, department="Computer Science", semester=4)
        db.add(course)
        db.flush()
        session = ClassSession(course_id=course.id, faculty_id=faculty.id, starts_at=utcnow()-timedelta(minutes=5), ends_at=utcnow()+timedelta(hours=1), headcount=55)
        db.add(session)
        db.flush()
        db.add_all(SessionStudent(session_id=session.id, student_id=s.id) for s in students)
        db.commit()

    def override_db():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as client:
        yield {"client": client, "db": factory, "admin": admin, "faculty": faculty, "other": other, "students": students, "session": session, "course": course}
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def sign_in(world, user):
    world["client"].cookies.set("attendance_token", make_token(user))
    return world["client"]