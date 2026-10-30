from pydantic import BaseModel
from typing import Optional

class QuestionRequest(BaseModel):
    question: str
    use_openai: Optional[bool] = False
    pdf_id: Optional[str] = None

class UploadResponse(BaseModel):
    message: str
    pdf_id: str
