from datetime import timedelta

import jwt
import pytest
from sqlalchemy import select

from app.config import Settings
from app.main import csv_cell
from app.models import Attendance, User, utcnow
from tests.conftest import sign_in
from tests.test_attendance import qr_token, submit


def test_login_cookies_logout_and_static_assets(world):
    client = world["client"]
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/styles.css").status_code == 200
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"email": "admin@example.com", "password": "incorrect"}).status_code == 401
    response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "TestingPassword!2026"})
    assert response.status_code == 200
    assert "httponly" in response.headers["set-cookie"].lower()
    assert "samesite=strict" in response.headers["set-cookie"].lower()
    assert "password_hash" not in response.text
    assert client.get("/api/auth/me").json()["role"] == "admin"
    assert client.post("/api/auth/logout", json={}).status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_role_isolation_and_forged_jwt(world):
    client = sign_in(world, world["students"][0])
    for path in ("/api/users", "/api/reports", "/api/audit-logs", "/api/fraud-logs"):
        assert client.get(path).status_code == 403
    assert client.post(f'/api/sessions/{world["session"].id}/qr', json={}).status_code == 403
    detail = client.get(f'/api/sessions/{world["session"].id}').json()
    assert len(detail["attendance"]) == 1
    assert detail["attendance"][0]["student_id"] == world["students"][0].id
    client = sign_in(world, world["other"])
    assert client.get("/api/sessions").json() == []
    assert client.get(f'/api/sessions/{world["session"].id}').status_code == 403
    assert client.put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 1}).status_code == 403
    client.cookies.set("attendance_token", jwt.encode({"sub": str(world["admin"].id), "exp": utcnow()+timedelta(hours=1)}, "wrong-key-that-is-long-enough-123456", algorithm="HS256"))
    assert client.get("/api/users").status_code == 401


def test_csrf_and_security_headers(world):
    client = sign_in(world, world["admin"])
    response = client.post("/api/auth/logout", json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.post("/api/auth/logout", json={}, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/auth/logout", data={}).status_code == 415
    response = client.get("/api/users")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-frame-options"] == "DENY"
    assert "default-src 'self'" in response.headers["content-security-policy"]


def test_login_rate_limiting(world):
    client = world["client"]
    for _ in range(10):
        assert client.post("/api/auth/login", json={"email": "admin@example.com", "password": "incorrect"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "admin@example.com", "password": "incorrect"}).status_code == 429


def test_admin_management_and_roster_snapshot(world):
    client = sign_in(world, world["admin"])
    student = {"name": "New Student", "email": "new@example.com", "password": "LongEnoughPassword!", "role": "student", "roll_number": "CS-999", "department": "Computer Science", "semester": 4}
    response = client.post("/api/users", json=student)
    assert response.status_code == 201
    assert client.post("/api/users", json=student).status_code == 409
    assert client.get(f'/api/sessions/{world["session"].id}').json()["class_strength"] == 60
    student_id = response.json()["id"]
    update = {key: student[key] for key in ("name", "email", "roll_number", "department", "semester")}
    update["active"] = False
    assert client.put(f"/api/students/{student_id}", json=update).status_code == 200
    assert client.post("/api/auth/login", json={"email": student["email"], "password": student["password"]}).status_code == 401
    with world["db"]() as db:
        user = db.get(User, student_id)
        assert user.password_hash != student["password"]
        assert user.password_hash.startswith("$argon2id$")
    course = {"code": "CS900", "name": "New course", "faculty_id": world["faculty"].id, "department": "Computer Science", "semester": 4}
    response = client.post("/api/courses", json=course)
    assert response.status_code == 201
    course["active"] = False
    assert client.put(f'/api/courses/{response.json()["id"]}', json=course).json()["active"] is False


def test_reports_include_absences_and_export(world):
    token = qr_token(world)
    assert submit(world, token).status_code == 201
    client = sign_in(world, world["faculty"])
    for period in ("daily", "monthly"):
        response = client.get("/api/reports", params={"period": period, "day": utcnow().date().isoformat()})
        assert response.status_code == 200
        assert len(response.json()["rows"]) == 60
        assert sum(r["status"] == "ABSENT" for r in response.json()["rows"]) == 59
    response = client.get("/api/reports?download=true")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert "password" not in response.text
    assert len(response.text.splitlines()) == 61
    assert csv_cell("=1+1") == "'=1+1"
    assert csv_cell("  @SUM(A1)").startswith("'")


def test_validation_and_production_configuration(world):
    client = sign_in(world, world["faculty"])
    now = utcnow().isoformat()
    assert client.post("/api/sessions", json={"course_id": world["course"].id, "starts_at": now, "ends_at": now}).status_code == 422
    assert client.post("/api/sessions", json={"course_id": world["course"].id, "starts_at": now, "ends_at": (utcnow()+timedelta(hours=1)).isoformat(), "latitude": 12}).status_code == 422
    with pytest.raises(ValueError):
        Settings(environment="production", jwt_secret="short")
    with pytest.raises(ValueError):
        Settings(environment="production", jwt_secret="a"*48, cookie_secure=False)
    settings = Settings(environment="production", jwt_secret="a"*48, cookie_secure=True, public_url="https://campus.example.com")
    assert settings.environment == "production"


def test_expired_jwt_and_deactivated_account(world):
    client = world["client"]
    from app.config import get_settings
    token = jwt.encode({"sub": str(world["admin"].id), "iat": utcnow()-timedelta(hours=9), "exp": utcnow()-timedelta(hours=1), "iss": "attendly"}, get_settings().jwt_secret, algorithm="HS256")
    client.cookies.set("attendance_token", token)
    assert client.get("/api/auth/me").status_code == 401
    client = sign_in(world, world["students"][0])
    with world["db"]() as db:
        db.get(User, world["students"][0].id).active = False
        db.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_block_is_preserved_by_headcount_changes(world):
    token = qr_token(world)
    record = submit(world, token).json()
    client = sign_in(world, world["faculty"])
    client.put(f'/api/attendance/{record["id"]}/review', json={"decision": "BLOCKED", "reason": "Invalid proxy attendance"})
    client.put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 60})
    with world["db"]() as db:
        assert db.scalar(select(Attendance)).status == "BLOCKED"