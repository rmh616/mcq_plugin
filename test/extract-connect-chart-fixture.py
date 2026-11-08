"""Extract only visible question markup, worksheet tables and referenced chart.

Usage: python test/extract-connect-chart-fixture.py <saved Connect HTML>
Requires beautifulsoup4. Site scripts, account data and tool state are not copied.
"""
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

from bs4 import BeautifulSoup, Comment

source = Path(sys.argv[1]).resolve()
target = Path(__file__).resolve().parent
soup = BeautifulSoup(source.read_text(encoding='utf-8'), 'html.parser')
worksheet = soup.select_one('.worksheet__main')
if worksheet is None:
    raise ValueError('No worksheet found')
for element in worksheet.select('script, noscript'):
    element.decompose()
for comment in worksheet.find_all(string=lambda value: isinstance(value, Comment)):
    comment.extract()
for element in worksheet.select('[id]'):
    if element.name != 'iframe' and element.get('id') != 'goReactSpinner':
        del element['id']
frames = worksheet.select('iframe.external[title="Assessment Tool iFrame"]')
if len(frames) != 3:
    raise ValueError('Expected three worksheet parts')
for index, frame in enumerate(frames):
    frame_source = source.parent / unquote(frame['src'])
    doc = BeautifulSoup(frame_source.read_text(encoding='utf-8'), 'html.parser')
    table = doc.select_one('#jQuerySheet table.jSheet')
    if table is None:
        raise ValueError('No worksheet table')
    for element in table.select('script, input, textarea'):
        element.decompose()
    name = f'connect-chart-part-{index + 1}-fixture.html'
    (target / name).write_text(
        '<!doctype html><meta charset="utf-8">'
        '<!-- Saved Connect worksheet table; scripts and tool state omitted. -->'
        '<style>body{margin:0;font:14px sans-serif}td{border:1px solid #aaa}'
        'caption{display:none}.jSheetInPlaceEdit{display:block;width:100px;height:24px}</style>'
        '<body class="test-mode accountingtool_baseaccountingtool">'
        '<div id="loading_image" style="display:none">Loading</div>'
        '<div id="jQuerySheet">' + str(table) + '</div></body>', encoding='utf-8')
    frame['src'] = './' + name
    for attr in ('allow', 'allowfullscreen', 'id', 'name'):
        frame.attrs.pop(attr, None)
chart = worksheet.select_one('img:not(.loading)')
shutil.copyfile(source.parent / unquote(chart['src']), target / 'vision-assets/connect-job-placement.jpg')
chart['src'] = './vision-assets/connect-job-placement.jpg'
chart['id'] = 'chart'
for image in worksheet.select('img.loading'):
    image['src'] = './vision-assets/connect-job-placement.jpg'
(target / 'connect-chart-worksheet-fixture.html').write_text(
    '<!doctype html><meta charset="utf-8">'
    '<!-- Saved outer question markup only; scripts and account data omitted. -->'
    + str(worksheet), encoding='utf-8')
print('Extracted outer worksheet, three tables and original chart')
