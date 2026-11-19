"""Local video inspection for chat attachments; no creative-workbench dependency."""
import math

MAX_CHAT_VIDEO_SECONDS = 180.0


def inspect_video(source):
    from moviepy import VideoFileClip
    with VideoFileClip(str(source), audio=False) as clip:
        duration = float(clip.duration)
        if not math.isfinite(duration) or not 0 < duration <= MAX_CHAT_VIDEO_SECONDS:
            raise ValueError('请使用 3 分钟以内的视频附件')
        return dict(duration=duration)
