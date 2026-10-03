from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator


class LoginInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class UserInput(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    role: Literal["admin", "faculty", "student"] = "student"
    roll_number: str = Field(default="", max_length=40)
    department: str = Field(default="Computer Science", min_length=1, max_length=100)
    semester: int = Field(default=1, ge=1, le=12)

    @model_validator(mode="after")
    def student_roll(self):
        if self.role == "student" and not self.roll_number.strip():
            raise ValueError("Roll number is required for students")
        return self


class StudentUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    roll_number: str = Field(min_length=1, max_length=40)
    department: str = Field(min_length=1, max_length=100)
    semester: int = Field(ge=1, le=12)
    active: bool = True


class CourseInput(BaseModel):
    code: str = Field(min_length=2, max_length=30)
    name: str = Field(min_length=2, max_length=120)
    faculty_id: int
    department: str = Field(min_length=1, max_length=100)
    semester: int = Field(ge=1, le=12)
    active: bool = True


class SessionInput(BaseModel):
    course_id: int
    starts_at: datetime
    ends_at: datetime
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    radius_m: int | None = Field(default=None, ge=10, le=5000)

    @model_validator(mode="after")
    def valid_window(self):
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None:
            raise ValueError("Session times must include a timezone")
        if self.ends_at <= self.starts_at:
            raise ValueError("End time must be after start time")
        fields = [self.latitude, self.longitude, self.radius_m]
        if any(x is not None for x in fields) and not all(x is not None for x in fields):
            raise ValueError("Geofence requires latitude, longitude and radius")
        return self


class HeadcountInput(BaseModel):
    headcount: int = Field(ge=0)


class ScanInput(BaseModel):
    session_id: int
    token: str = Field(min_length=10, max_length=200)
    device_id: str = Field(min_length=8, max_length=200)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class ReviewInput(BaseModel):
    decision: Literal["PRESENT", "BLOCKED"]
    reason: str = Field(min_length=5, max_length=500)