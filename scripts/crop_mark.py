from PIL import Image

src = "public/werk-mark.png"
im = Image.open(src).convert("RGBA")
bbox = im.getbbox()  # bounds of all non-zero (non-transparent) pixels
print("original", im.size, "bbox", bbox)
if bbox:
    cropped = im.crop(bbox)
    # small even padding so edges don't clip
    pad = 6
    out = Image.new("RGBA", (cropped.width + pad * 2, cropped.height + pad * 2), (0, 0, 0, 0))
    out.paste(cropped, (pad, pad))
    out.save(src)
    print("cropped ->", out.size)
