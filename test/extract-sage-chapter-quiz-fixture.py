"""Extract relevant links only; exclude account data, scripts, and page body text."""
from html import escape
from html.parser import HTMLParser
from pathlib import Path
import sys

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.current = [dict(attrs), []]
    def handle_data(self, data):
        if self.current is not None:
            self.current[1].append(data)
    def handle_endtag(self, tag):
        if tag == 'a' and self.current is not None:
            self.links.append((self.current[0], ' '.join(''.join(self.current[1]).split())))
            self.current = None

parser = Links()
parser.feed(Path(sys.argv[1]).read_text(encoding='utf-8'))
def find(predicate):
    return next(link for link in parser.links if predicate(*link))
def markup(link):
    attrs, label = link
    allowed = ['href', 'id', 'class', 'title', 'aria-label', 'target']
    return '<a ' + ' '.join(f'{key}="{escape(attrs[key], quote=True)}"' for key in allowed if key in attrs) + '>' + escape(label) + '</a>'
next_quiz = find(lambda a,t: t == 'Next: Chapter Quiz')
activities = [link for link in parser.links if link[1].lower() == 'do the activity']
previous = find(lambda a,t: a.get('aria-label','').startswith('Go to Previous Content: Knowledge Check'))
sidebar = find(lambda a,t: a.get('aria-label','').startswith('Go to Next Content: Chapter'))
skip = find(lambda a,t: 'top-tab' in a.get('class','') and '#next-page' in a.get('href',''))
header = find(lambda a,t: not t and a.get('aria-label','').startswith('Go to Chapter'))
output = '<header>' + markup(header) + '</header><div id="top-skip-links">' + markup(skip) + '</div><main>'
output += ''.join('<section class="data-activity reading-activity">' + markup(link) + '</section>' for link in activities)
output += '<div class="next-page">' + markup(next_quiz) + '</div></main>'
output += '<aside><div class="navagation"><ul class="navagation-list"><li>' + markup(previous) + '</li><li>' + markup(sidebar) + '</li></ul></div></aside>'
Path(__file__).with_name('sage-chapter-quiz-fixture.html').write_text(output + '\n', encoding='utf-8')
print(f'Extracted Chapter Quiz, {len(activities)} activities, sidebar, previous and skip links')
