"""Extract question text, controls and referenced graph assets, without account data/scripts."""
import re
import sys
import shutil
from html import escape
from pathlib import Path

source = Path(sys.argv[1])
html = source.read_text(encoding='utf-8')
starts = list(re.finditer(r'<div class="display_question question ([^\"]+)" id="(question_\d+)"', html))
out = []
assets = Path(__file__).with_name('vision-assets')
for i, match in enumerate(starts):
    chunk = html[match.start():starts[i + 1].start() if i + 1 < len(starts) else len(html)]
    stem = re.search(r'<div id="question_\d+_question_text" class="question_text[^\"]*">([\s\S]*?)</div>', chunk)[1]
    for image in re.findall(r'<img[^>]+src="([^"]+)"', stem):
        original = source.parent / image
        if original.is_file():
            assets.mkdir(exist_ok=True)
            shutil.copyfile(original, assets / original.name)
            stem = stem.replace(image, './vision-assets/' + original.name)
    if match[1] == 'matching_question':
        rows = []
        for attrs, body in re.findall(r'<select([^>]+)>([\s\S]*?)</select>', chunk):
            control_id = re.search(r'\bid="([^"]+)"', attrs)[1]
            label = re.search(r'<label for="' + re.escape(control_id) + r'">([\s\S]*?)</label>', chunk)[1]
            rows.append(f'<div class="answer"><label for="{escape(control_id)}">{label}</label><select{attrs}>{body}</select></div>')
        answers = ''.join(rows)
    else:
        controls = re.findall(r'<div class="select_answer answer_type">\s*(<input[^>]+>[\s\S]*?<label[^>]+>[\s\S]*?</label>)', chunk)
        if not controls:
            controls = re.findall(r'(<label class="answer_row[^\"]*">[\s\S]*?</label>)', chunk)
        if len(controls) < 2:
            raise ValueError('Missing controls: ' + match[2])
        controls = [re.sub(r' __mcq_\w+', '', control) for control in controls]
        answers = ''.join('<div class="answer">' + c + '</div>' for c in controls)
    out.append(f'<div class="question {match[1]}" id="{match[2]}"><div class="question_text">{stem}</div><div class="answers">{answers}</div></div>')
Path(__file__).with_name('canvas-vision-fixture.html').write_text('\n'.join(out), encoding='utf-8')
print(f'Extracted {len(out)} questions and their graph assets')
