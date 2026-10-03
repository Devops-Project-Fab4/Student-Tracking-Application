import secrets
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "sqlite:///./attendance.db"
    jwt_secret: str = ""
    environment: str = "development"
    cookie_secure: bool = False
    public_url: str = "http://localhost:8000"
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""

    def model_post_init(self, context):
        if self.environment == "production":
            if len(self.jwt_secret) < 32:
                raise ValueError("Production JWT_SECRET must contain at least 32 characters")
            if not self.cookie_secure or not self.public_url.startswith("https://"):
                raise ValueError("Production requires COOKIE_SECURE=true and HTTPS PUBLIC_URL")
        if not self.jwt_secret:
            self.jwt_secret = secrets.token_urlsafe(48)


@lru_cache
def get_settings():
    return Settings()