import hashlib
from datetime import timedelta

import jwt
from fastapi import Depends, HTTPException, Request
from pwdlib import PasswordHash
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import User, utcnow

passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash("not-a-real-account-password")


def digest(value: str):
    return hashlib.sha256(value.encode()).hexdigest()


def make_token(user: User):
    now = utcnow()
    return jwt.encode({"sub": str(user.id), "iat": now, "exp": now + timedelta(hours=8), "iss": "attendly"}, get_settings().jwt_secret, algorithm="HS256")


def current_user(request: Request, db: Session = Depends(get_db)):
    try:
        payload = jwt.decode(request.cookies.get("attendance_token", ""), get_settings().jwt_secret, algorithms=["HS256"], issuer="attendly", options={"require": ["exp", "iat", "sub"]})
        user = db.get(User, int(payload["sub"]))
    except (jwt.InvalidTokenError, ValueError, TypeError):
        raise HTTPException(401, "Please sign in") from None
    if not user or not user.active:
        raise HTTPException(401, "Account unavailable")
    return user


def require_staff(user: User = Depends(current_user)):
    if user.role not in ("admin", "faculty"):
        raise HTTPException(403, "Staff access required")
    return user


def require_admin(user: User = Depends(current_user)):
    if user.role != "admin":
        raise HTTPException(403, "Administrator access required")
    return user