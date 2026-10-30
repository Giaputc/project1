import os
from openai import OpenAI

class LLMService:
    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key:
            self.client = OpenAI(api_key=api_key)
        else:
            self.client = None

    def available(self) -> bool:
        return self.client is not None

    def ask(self, prompt: str, model: str = "gpt-4o-mini") -> str:
        if not self.client:
            raise RuntimeError("OpenAI API key not configured. Set OPENAI_API_KEY in env to use LLM.")
        resp = self.client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=800,
        )
        return resp.choices[0].message.content
