"""Quick check that the Gemini key in gemini_key.txt has usable credits (costs a fraction of a cent)."""
import os, sys
from pathlib import Path
key = os.environ.get("GEMINI_API_KEY") or (Path(__file__).parent / "gemini_key.txt").read_text().strip()
from google import genai
try:
    client = genai.Client(api_key=key)
    client.models.generate_content(model="gemini-3.5-flash", contents="Say OK")
    print(f"OK: key ...{key[-4:]} has credits. Ready to build.")
except Exception as e:
    print(f"Not yet: key ...{key[-4:]}: {str(e)[:160]}")
    sys.exit(1)
