const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { httpError } = require('../auth/auth.middleware');

// Product photos live on local disk for now (the storage decision is revisited
// before production). Files are served by the API at /uploads/products/<name>.
const UPLOADS_ROOT = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', '..', 'uploads');
const PRODUCTS_DIR = path.join(UPLOADS_ROOT, 'products');
const PUBLIC_PREFIX = '/uploads/products/';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 8;

// The type is decided from the file's own first bytes, never from the name or the
// Content-Type header the client sent.
function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  return null;
}

// Held in memory (10 MB x 8 at most) so a refused file never touches the disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
});

// Express middleware: reads `photos` and turns multer's errors into API errors.
function readPhotos(req, res, next) {
  upload.array('photos', MAX_FILES_PER_REQUEST)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(400, 'Each photo must be 10 MB or smaller.', 'FILE_TOO_LARGE'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(httpError(400, `Add up to ${MAX_FILES_PER_REQUEST} photos.`, 'TOO_MANY_FILES'));
    }
    return next(httpError(400, 'The upload could not be read.', 'BAD_UPLOAD'));
  });
}

// Validates every file, then writes them under random names. Returns the public
// URLs, or throws a 400 without leaving partial files behind.
async function storePhotos(files) {
  if (!files || files.length === 0) throw httpError(400, 'Choose at least one photo.', 'NO_FILES');

  const typed = files.map((file) => {
    const type = detectImageType(file.buffer);
    if (!type) throw httpError(400, `"${file.originalname}" is not a JPG or PNG photo.`, 'BAD_FILE_TYPE');
    return { file, type };
  });

  await fs.promises.mkdir(PRODUCTS_DIR, { recursive: true });
  const written = [];
  try {
    for (const { file, type } of typed) {
      const name = `${crypto.randomUUID()}.${type}`;
      await fs.promises.writeFile(path.join(PRODUCTS_DIR, name), file.buffer, { flag: 'wx' });
      written.push(name);
    }
  } catch (err) {
    await Promise.all(written.map((name) => removeFile(`${PUBLIC_PREFIX}${name}`)));
    throw err;
  }
  return written.map((name) => `${PUBLIC_PREFIX}${name}`);
}

// Deletes a stored photo by its public URL. Only names this module generated are
// accepted, so a URL can never point outside the products folder.
async function removeFile(url) {
  const name = path.basename(String(url));
  if (!url.startsWith(PUBLIC_PREFIX) || !/^[0-9a-f-]{36}\.(jpg|png)$/.test(name)) return;
  await fs.promises.rm(path.join(PRODUCTS_DIR, name), { force: true });
}

module.exports = { UPLOADS_ROOT, PRODUCTS_DIR, PUBLIC_PREFIX, MAX_FILE_BYTES, readPhotos, storePhotos, removeFile };
