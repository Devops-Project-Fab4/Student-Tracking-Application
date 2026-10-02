from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from sqlalchemy import select

from app.models import Attendance, ClassSession, FraudLog, SessionStudent, utcnow
from app.security import make_token
from tests.conftest import sign_in


def qr_token(world):
    client = sign_in(world, world["faculty"])
    result = client.post(f'/api/sessions/{world["session"].id}/qr', json={})
    assert result.status_code == 200, result.text
    assert result.json()["image"].startswith("data:image/png;base64,")
    return parse_qs(urlsplit(result.json()["url"]).fragment)["token"][0]


def submit(world, token, index=0, device=None, **extra):
    client = sign_in(world, world["students"][index])
    return client.post("/api/attendance/scan", json={"session_id": world["session"].id, "token": token, "device_id": device or f"test-device-{index}", **extra})


def test_required_60_55_57_scenario(world):
    token = qr_token(world)
    for index in range(57):
        response = submit(world, token, index)
        assert response.status_code == 201, response.text
        assert response.json()["status"] == ("PRESENT" if index < 55 else "UNDER_REVIEW")
    client = sign_in(world, world["faculty"])
    detail = client.get(f'/api/sessions/{world["session"].id}').json()
    assert {key: detail[key] for key in ("class_strength", "headcount", "responses", "valid", "suspicious", "absent", "excess")} == {"class_strength": 60, "headcount": 55, "responses": 57, "valid": 55, "suspicious": 2, "absent": 3, "excess": 2}
    under_review = [row for row in detail["attendance"] if row["status"] == "UNDER_REVIEW"]
    response = client.put(f'/api/attendance/{under_review[0]["id"]}/review', json={"decision": "PRESENT", "reason": "Reviewed classroom record"})
    assert response.status_code == 409
    report = client.get("/api/reports", params={"period": "suspicious", "day": utcnow().date().isoformat()}).json()
    assert len(report["rows"]) == 2


def test_duplicate_and_multi_device(world):
    token = qr_token(world)
    assert submit(world, token).status_code == 201
    assert submit(world, token).status_code == 409
    response = submit(world, token, device="different-device")
    assert response.status_code == 409
    assert "MULTI_DEVICE" in response.json()["detail"]
    with world["db"]() as db:
        rows = list(db.scalars(select(Attendance)))
        assert len(rows) == 1
        assert rows[0].status == "UNDER_REVIEW"
        assert {x.kind for x in db.scalars(select(FraudLog))} == {"DUPLICATE", "MULTI_DEVICE"}


def test_shared_device_flags_both_students(world):
    token = qr_token(world)
    assert submit(world, token, 0, device="shared-device").status_code == 201
    assert submit(world, token, 1, device="shared-device").json()["status"] == "UNDER_REVIEW"
    with world["db"]() as db:
        assert all(row.status == "UNDER_REVIEW" for row in db.scalars(select(Attendance)))


def test_expiry_rotation_and_invalid_token(world):
    old = qr_token(world)
    new = qr_token(world)
    assert submit(world, old).status_code == 400
    assert submit(world, "invalid-token-value").status_code == 400
    with world["db"]() as db:
        db.get(ClassSession, world["session"].id).qr_expires = utcnow() - timedelta(seconds=1)
        db.commit()
    assert submit(world, new).status_code == 400
    with world["db"]() as db:
        assert list(db.scalars(select(Attendance))) == []
        assert len(list(db.scalars(select(FraudLog)))) == 3


def test_unknown_headcount_then_reconcile(world):
    with world["db"]() as db:
        db.get(ClassSession, world["session"].id).headcount = None
        db.commit()
    token = qr_token(world)
    for i in range(3):
        assert submit(world, token, i).json()["status"] == "UNDER_REVIEW"
    client = sign_in(world, world["faculty"])
    result = client.put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 2}).json()
    assert (result["valid"], result["suspicious"]) == (2, 1)
    result = client.put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 0}).json()
    assert (result["valid"], result["suspicious"]) == (0, 3)
    assert client.put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 61}).status_code == 422


def test_block_then_approve_with_audit(world):
    token = qr_token(world)
    first = submit(world, token, 0, device="shared-device").json()
    second = submit(world, token, 1, device="shared-device").json()
    client = sign_in(world, world["faculty"])
    assert client.put(f'/api/attendance/{first["id"]}/review', json={"decision": "BLOCKED", "reason": "Student confirmed not in class"}).json()["status"] == "BLOCKED"
    assert client.put(f'/api/attendance/{second["id"]}/review', json={"decision": "PRESENT", "reason": "Verified student physically present"}).json()["status"] == "PRESENT"
    admin = sign_in(world, world["admin"])
    assert len([log for log in admin.get("/api/audit-logs").json() if log["action"] == "REVIEW_ATTENDANCE"]) == 2


def test_geofence_missing_outside_and_inside(world):
    with world["db"]() as db:
        session = db.get(ClassSession, world["session"].id)
        session.latitude, session.longitude, session.radius_m = 12.97, 77.59, 100
        db.commit()
    token = qr_token(world)
    assert submit(world, token, 0).json()["status"] == "UNDER_REVIEW"
    assert submit(world, token, 1, latitude=13.0, longitude=78.0).json()["status"] == "UNDER_REVIEW"
    assert submit(world, token, 2, latitude=12.97, longitude=77.59).json()["status"] == "PRESENT"


def test_closed_and_future_sessions(world):
    token = qr_token(world)
    client = sign_in(world, world["faculty"])
    assert client.post(f'/api/sessions/{world["session"].id}/close', json={}).status_code == 200
    assert submit(world, token).status_code == 400
    client = sign_in(world, world["faculty"])
    assert client.post(f'/api/sessions/{world["session"].id}/qr', json={}).status_code == 409
    response = client.post("/api/sessions", json={"course_id": world["course"].id, "starts_at": (utcnow()+timedelta(hours=1)).isoformat(), "ends_at": (utcnow()+timedelta(hours=2)).isoformat()})
    assert response.status_code == 201
    assert response.json()["class_strength"] == 60
    assert client.post(f'/api/sessions/{response.json()["id"]}/qr', json={}).status_code == 409


def test_unenrolled_student_cannot_scan(world):
    token = qr_token(world)
    with world["db"]() as db:
        db.delete(db.get(SessionStudent, (world["session"].id, world["students"][0].id)))
        db.commit()
    assert submit(world, token).status_code == 403


def test_parallel_scans_respect_capacity(world):
    token = qr_token(world)
    sign_in(world, world["faculty"]).put(f'/api/sessions/{world["session"].id}/headcount', json={"headcount": 2})

    def send(index):
        # One app lifespan, concurrent requests; do not restart SQLite in each thread.
        cookie = "attendance_token=" + make_token(world["students"][index])
        return world["client"].post("/api/attendance/scan", headers={"Cookie": cookie}, json={"session_id": world["session"].id, "token": token, "device_id": f"parallel-device-{index}"})

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(send, range(4)))
    assert all(r.status_code == 201 for r in responses)
    with world["db"]() as db:
        statuses = [r.status for r in db.scalars(select(Attendance))]
        assert statuses.count("PRESENT") == 2
        assert statuses.count("UNDER_REVIEW") == 2