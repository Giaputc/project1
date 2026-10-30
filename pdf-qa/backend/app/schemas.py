from pydantic import BaseModel
from datetime import datetime
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Security

bearer_scheme = HTTPBearer()

# ---------- User ----------
class UserBase(BaseModel):
    username: str

class UserCreate(UserBase):
    password: str
    role: str = "user"

class UserOut(UserBase):
    id: int
    role: str
    model_config = {"from_attributes": True}

# ---------- PDF ----------
class PDFBase(BaseModel):
    filename: str

class PDFCreate(PDFBase):
    content: str

class PDFOut(BaseModel):
    id: int
    filename: str
    model_config = {"from_attributes": True}

# ---------- History ----------
class HistoryBase(BaseModel):
    question: str
    answer: str

class HistoryOut(HistoryBase):
    id: int
    user_id: int
    pdf_id: int
    timestamp: datetime
    model_config = {"from_attributes": True}
