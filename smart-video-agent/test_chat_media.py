"""Real local FFmpeg coverage for chat's three-minute video contract; no network."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import imageio_ffmpeg

from chat_media import inspect_video


class ChatMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='hamster-chat-media-test-')
        cls.root = Path(cls.temporary.name)
        cls.videos = {}
        for duration in (60.1, 179.9, 180.0, 180.1):
            video = cls.root / f'{duration}.mp4'
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y', '-loglevel', 'error',
                            '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10', '-t', str(duration),
                            '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                            '-pix_fmt', 'yuv420p', str(video)], check=True, capture_output=True)
            cls.videos[duration] = video

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_real_video_past_old_reverse_limit_and_up_to_three_minutes(self):
        for duration in (60.1, 179.9, 180.0):
            with self.subTest(duration=duration):
                self.assertAlmostEqual(inspect_video(self.videos[duration])['duration'], duration, places=2)

    def test_real_video_over_three_minutes_is_rejected_and_handles_are_released(self):
        with self.assertRaises(ValueError):
            inspect_video(self.videos[180.1])
        # Windows refuses this rename if MoviePy/FFmpeg retained the file handle.
        renamed = self.videos[180.1].with_suffix('.checked.mp4')
        self.videos[180.1].rename(renamed)
        renamed.rename(self.videos[180.1])

    def test_invalid_local_video_is_rejected(self):
        invalid = self.root / 'invalid.mp4'
        invalid.write_bytes(b'not a video')
        with self.assertRaises(Exception):
            inspect_video(invalid)


if __name__ == '__main__':
    unittest.main()
