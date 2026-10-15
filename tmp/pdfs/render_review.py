from pathlib import Path
from collections import Counter
import pypdfium2 as pdfium
import pdfplumber
from PIL import Image, ImageDraw

root = Path(__file__).parent
src = r'D:\Downloads\B18_EEE_Project_Report_Phase1_Final_Polished (1) (1) (1) (1).pdf'
doc = pdfium.PdfDocument(src)
for start in range(0,len(doc),12):
    sheet = Image.new('RGB',(1000,1140),'#cccccc')
    draw = ImageDraw.Draw(sheet)
    for j in range(start,min(start+12,len(doc))):
        im = doc[j].render(scale=0.42).to_pil().convert('RGB')
        im.thumbnail((240,340))
        x, y = ((j-start)%4)*250,((j-start)//4)*380
        sheet.paste(im,(x,y+25))
        draw.text((x+5,y+5),f'PDF {j+1} / report {j-14 if j>=15 else "front"}',fill='black')
    sheet.save(root/f'contact_{start+1:02}.png')
for n in [1,2,3,5,13,23,27,29,30,36,38,39,40,45,48,49,55,62,63,64,65,68,70,73,78,79,81]:
    doc[n-1].render(scale=1.5).to_pil().save(root/f'page_{n:02}.png')
with pdfplumber.open(src) as pdf:
    for n in [1,2,3,5,6,16,23,36,45,68,81]:
        p=pdf.pages[n-1]
        cnt=Counter((c['fontname'],round(c['size'],1)) for c in p.chars)
        print('PDF PAGE',n,'fonts',cnt.most_common(6))
        lines=p.extract_text_lines()
        print('positions',[(l['text'][:60],round(l['x0'],1),round(l['x1'],1),round(l['top'],1)) for l in lines[:8]])
