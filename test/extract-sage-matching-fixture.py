"""Copy only the matching fieldset; no scripts, request tokens or account data."""
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r'<fieldset>\s*<div class="question-area" id="matchingType">[\s\S]*?</fieldset>', source)
if not match:
    raise ValueError("Sage matching fieldset not found")
fieldset = re.sub(r'<script\b[\s\S]*?</script>', '', match[0], flags=re.I)
output = Path(__file__).with_name('sage-matching-fixture.html')
output.write_text(fieldset + '\n', encoding="utf-8")
print(f"Extracted {fieldset.count('<select ')} matching rows to {output.name}")
