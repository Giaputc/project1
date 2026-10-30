from pdf2image import convert_from_path

pdf_path = r"D:\N5\KI_1\2.ChuyenDeCNTT\pdf-qa\backend\storage\pdfs\BaiTap.pdf"
poppler_path = r"C:\Users\DELL\Downloads\Release-25.07.0-0\poppler-25.07.0\Library\bin"

imgs = convert_from_path(pdf_path, dpi=100, poppler_path=poppler_path)
print(f"Số trang: {len(imgs)}")
imgs[0].show()
