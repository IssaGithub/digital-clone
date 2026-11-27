import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

os.environ["CLONE_DIR"] = tempfile.mkdtemp(prefix="klon-test-")

import clone_store


class CloneStoreTest(unittest.TestCase):
    def test_parts_need_all_three(self):
        with self.assertRaises(RuntimeError):
            clone_store.check_parts(b"", b"1234", b"12345678")

    def test_small_photo_is_rejected(self):
        with self.assertRaises(RuntimeError):
            clone_store.check_parts(b"1234567", b"12345", b"123456789")

    def test_compose_keeps_a_pixel_and_opens_the_jaw(self):
        photo = bytearray(clone_store.WIDTH * clone_store.HEIGHT * 4)
        for y in range(clone_store.HEIGHT):
            for x in range(clone_store.WIDTH):
                index = (y * clone_store.WIDTH + x) * 4
                photo[index] = y % 256
                photo[index + 3] = 255
        photo[100 * clone_store.WIDTH * 4 + 100 * 4] = 9
        still = clone_store.compose_portrait(bytes(photo), 0, [8, 0])
        moved = 100 * clone_store.WIDTH * 4 + 116 * 4
        self.assertEqual(still[moved], 9)
        talking = clone_store.compose_portrait(bytes(photo), 1, [0, 0])
        y = int(clone_store.HEIGHT * 0.70)
        index = (y * clone_store.WIDTH + 10) * 4
        self.assertNotEqual(still[index], talking[index])

    def test_old_portrait_scales(self):
        folder = clone_store.ACTIVE
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        raw = bytearray(320 * 240 * 4)
        raw[0:4] = bytes((1, 2, 3, 255))
        (folder / "portrait.rgba").write_bytes(raw)
        scaled = clone_store.portrait()
        self.assertEqual(len(scaled), clone_store.WIDTH * clone_store.HEIGHT * 4)
        self.assertEqual(scaled[0:4], bytes((1, 2, 3, 255)))

    def test_browser_webm_duration_without_container_duration(self):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg fehlt")
        path = Path(tempfile.mkdtemp(prefix="klon-webm-")) / "browser.webm"
        result = subprocess.run(
            [
                "ffmpeg", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=160x120:rate=8:duration=2",
                "-f", "lavfi", "-i", "sine=frequency=180:duration=2",
                "-shortest", "-c:v", "libvpx-vp9", "-c:a", "libopus",
                "-f", "webm", "pipe:1",
            ],
            capture_output=True,
            check=True,
        )
        path.write_bytes(result.stdout)
        self.assertGreater(clone_store._seconds(path), 1.8)

    def test_save_roundtrip_when_ffmpeg_exists(self):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg fehlt")
        folder = Path(tempfile.mkdtemp(prefix="klon-media-"))
        photo = folder / "foto.jpg"
        voice = folder / "stimme.wav"
        video = folder / "video.mp4"
        short = folder / "kurz.wav"
        subprocess.check_call(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=1", "-frames:v", "1", str(photo)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.check_call(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=180:duration=4", "-ac", "1", "-ar", "16000", str(voice)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.check_call(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=180:duration=1", "-ac", "1", "-ar", "16000", str(short)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.check_call(
            [
                "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=8",
                "-f", "lavfi", "-i", "sine=frequency=220:duration=5",
                "-shortest", "-t", "5", "-pix_fmt", "yuv420p", str(video),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        saved = clone_store.save(photo.read_bytes(), voice.read_bytes(), video.read_bytes(), "  Studio  Klon  ")
        self.assertTrue(saved["ready"])
        self.assertEqual(saved["label"], "Studio Klon")
        self.assertEqual(len(clone_store.portrait()), clone_store.WIDTH * clone_store.HEIGHT * 4)
        self.assertTrue(clone_store.blob("foto"))
        with self.assertRaises(RuntimeError):
            clone_store.save(photo.read_bytes(), short.read_bytes(), video.read_bytes(), "Kurz")
        self.assertEqual(clone_store.view()["label"], "Studio Klon")


if __name__ == "__main__":
    unittest.main()
