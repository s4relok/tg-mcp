export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class BadRequestError extends HttpError {
  constructor(message) {
    super(400, 'bad_request', message);
    this.name = 'BadRequestError';
  }
}

export function isHttpError(error) {
  return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600;
}
