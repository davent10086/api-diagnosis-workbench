import sharp from "sharp";

/** Work on in-memory copies: preserve originals, enlarge small text and tile long chats. */
export async function prepareVisionImages(data: Buffer) {
  const oriented = await sharp(data, { limitInputPixels: 40_000_000, animated: false }).rotate().toBuffer({ resolveWithObject: true });
  const source = sharp(oriented.data, { limitInputPixels: 40_000_000 });
  const { width, height } = oriented.info;
  if (!width || !height) throw new Error("图片缺少有效尺寸。");
  const targetWidth = Math.min(1600, Math.max(1200, width));
  const scale = targetWidth / width;
  const tileHeight = height * scale > 2400 ? Math.floor(1800 / scale) : height;
  const overlap = tileHeight < height ? Math.floor(150 / scale) : 0;
  const step = Math.max(1, tileHeight - overlap);
  const images: { data: Buffer; mime: string; label: string }[] = [];
  let covered = 0;
  for (let top = 0; top < height && images.length < 8; top += step) {
    const cropHeight = Math.min(tileHeight, height - top);
    images.push({ data: await source.clone().extract({ left: 0, top, width, height: cropHeight }).resize({ width: targetWidth }).png().toBuffer(), mime: "image/png", label: `原图第 ${images.length + 1} 段（纵向 ${top}–${top + cropHeight} 像素）` });
    covered = top + cropHeight;
    if (covered === height) break;
  }
  return { images, warnings: covered < height ? ["长截图超过分段处理上限，末尾区域未识别；请拆分图片后补充。"] : [] };
}
