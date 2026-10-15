from pathlib import Path
import pypdfium2 as pdfium
import numpy as np

src = r'D:\Downloads\B18_EEE_Project_Report_Phase1_Final_Polished (1) (1) (1) (1).pdf'
doc = pdfium.PdfDocument(src)
for i in range(len(doc)):
    im = doc[i].render(scale=1.5).to_pil().convert('RGB')
    a = np.asarray(im).astype(np.int16)
    chroma = a.max(axis=2) - a.min(axis=2)
    count20 = int((chroma > 20).sum())
    count40 = int((chroma > 40).sum())
    if count20:
        print(f'PDF {i+1:02} | printed {"cover" if i==0 else (i-14 if i>=15 else "front")} | chroma>20: {count20} | chroma>40: {count40}')
        if count20 > 100:
            im.save(Path(__file__).parent / f'colour_{i+1:02}.png')
