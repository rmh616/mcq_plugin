"""Extract only question/answer DOM from the user's saved Canvas review HTML.

No scripts, cookies, identity details, answer feedback, or other page metadata are copied.
Usage: python test/extract-canvas-fixture.py <saved-html-path> [output-name.html] [--review-markers]
"""
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
review_markers = "--review-markers" in sys.argv[3:]
starts = list(re.finditer(r'<div class="display_question question (multiple_choice_question|multiple_answers_question|true_false_question)[^\"]*" id="(question_\d+)"', source))
questions = []
for i, start in enumerate(starts):
    chunk = source[start.start():starts[i + 1].start() if i + 1 < len(starts) else len(source)]
    stem = re.search(r'<div id="question_\d+_question_text" class="question_text[^\"]*">([\s\S]*?)</div>', chunk)
    controls = re.findall(r'<div class="select_answer answer_type">\s*(<input[^>]+>[\s\S]*?<label[^>]+>[\s\S]*?</label>)', chunk)
    if not stem or len(controls) < 2:
        raise ValueError(f"Unexpected question DOM: {start[2]}, controls={len(controls)}")
    rows = dict((row_id, classes.split()) for classes, row_id in re.findall(r'<div class="answer answer_for_([^\"]*)" id="(answer_\d+)"', chunk))
    answers = []
    for control in controls:
        classes = "answer"
        if review_markers:
            input_id = re.search(r'<input[^>]* id="answer-(\d+)"', control)
            row_classes = rows.get("answer_" + input_id[1], []) if input_id else []
            classes += ''.join(" " + marker for marker in ("correct_answer", "selected_answer") if marker in row_classes)
        answers.append('<div class="' + classes + '"><div class="select_answer answer_type">' + control + '</div></div>')
    answers = ''.join(answers)
    questions.append(f'<div class="display_question question {start[1]}" id="{start[2]}"><div class="text"><div class="question_text user_content enhanced">{stem[1]}</div><div class="answers">{answers}</div></div></div>')
if not questions:
    raise ValueError("No Canvas Classic questions found")
output = Path(__file__).with_name(sys.argv[2] if len(sys.argv) > 2 else "canvas-fixture.html")
output.write_text('\n'.join(questions) + '\n', encoding="utf-8")
print(f"Extracted {len(questions)} question DOM blocks into {output.name}")
