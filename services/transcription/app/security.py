"""Request-level protections that run before any route code (and before multipart parsing)."""
import json

TOO_LARGE_BODY = json.dumps(
    {"detail": "Request body exceeds the configured upload limit.", "code": "file_too_large"}
).encode()


class _BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    """Reject oversized bodies by declared Content-Length and by counting streamed bytes.

    Starlette buffers multipart uploads (to disk past a threshold) before the route runs, so a
    check inside the route cannot cap what a client makes the server receive.
    """

    def __init__(self, app, max_bytes: int, *, upload_path: str, default_max_bytes: int = 64 * 1024) -> None:
        self.app = app
        self.upload_max_bytes = max_bytes
        self.upload_path = upload_path
        self.default_max_bytes = default_max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Only the upload route may carry a large body; every other route gets a small strict cap.
        limit = self.upload_max_bytes if scope["path"] == self.upload_path else self.default_max_bytes
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            await self._reject(send)
            return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def tracking_send(message) -> None:
            nonlocal response_started
            if exceeded:
                # FastAPI turns any body-read exception into a 400; the real cause is the size.
                if message["type"] == "http.response.start":
                    response_started = True
                    await self._reject(send, start_only=True)
                elif message["type"] == "http.response.body" and not message.get("more_body"):
                    await send({"type": "http.response.body", "body": TOO_LARGE_BODY})
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if not response_started:
                await self._reject(send)

    @staticmethod
    async def _reject(send, *, start_only: bool = False) -> None:
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(TOO_LARGE_BODY)).encode()),
                (b"connection", b"close"),
            ],
        })
        if not start_only:
            await send({"type": "http.response.body", "body": TOO_LARGE_BODY})
