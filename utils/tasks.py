"""
Asyncio task helpers for safe fire-and-forget task creation.

Plain asyncio.create_task() silently swallows exceptions unless someone
awaits the task. These helpers ensure exceptions are always logged.
"""

import asyncio
import logging
from typing import Any, Callable, Coroutine, Optional

logger = logging.getLogger(__name__)


def create_safe_task(
    coro: Coroutine,
    name: Optional[str] = None,
    on_error: Optional[Callable[[Exception], None]] = None,
) -> asyncio.Task:
    """
    Create an asyncio task that logs any unhandled exception instead of
    silently discarding it.

    Args:
        coro:     The coroutine to run as a background task
        name:     Optional label shown in logs and asyncio task introspection
        on_error: Optional callback invoked with the exception if the task fails

    Returns:
        The created asyncio.Task
    """
    task = asyncio.create_task(coro, name=name)

    def _handle_exception(t: asyncio.Task) -> None:
        try:
            if not t.cancelled():
                exc = t.exception()
                if exc is not None:
                    logger.error(
                        f"Background task {t.get_name()!r} failed",
                        exc_info=(type(exc), exc, exc.__traceback__),
                    )
                    if on_error:
                        on_error(exc)
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            pass

    task.add_done_callback(_handle_exception)
    return task


async def safe_gather(*coros: Coroutine, return_exceptions: bool = False) -> list[Any]:
    """
    Run coroutines concurrently, logging every exception.

    Args:
        return_exceptions: If True, exceptions are returned as results.
                           If False, the first exception is re-raised.
    """
    results = await asyncio.gather(*coros, return_exceptions=True)

    processed: list[Any] = []
    for i, res in enumerate(results):
        if isinstance(res, Exception):
            logger.error(
                f"Task {i} in gather failed",
                exc_info=(type(res), res, res.__traceback__),
            )
            if not return_exceptions:
                raise res
        processed.append(res)

    return processed
