import os
import unittest
from unittest.mock import patch

os.environ.setdefault("SPEECH_LOCAL", "1")

import server


class SpeechPipelineTest(unittest.TestCase):
    def test_pcm_is_wrapped_as_whisper_wav(self):
        pcm = (1200).to_bytes(2, "little", signed=True) * 16000
        wav = server.pcm_wav(pcm)
        self.assertEqual(wav[:4], b"RIFF")
        self.assertGreater(server.pcm_level(pcm), 0)
        self.assertEqual(server.pcm_level(b"\0\0" * 100), 0)

    def test_local_transcription_passes_pcm_to_whisper(self):
        pcm = (500).to_bytes(2, "little", signed=True) * 16000
        wav = server.pcm_wav(pcm)

        class Segment:
            text = " Hallo "

        class Model:
            def transcribe(self, audio, language):
                self.audio = audio
                self.language = language
                return [Segment()], None

        model = Model()
        with patch.object(server, "whisper_model", return_value=model):
            self.assertEqual(server.transcribe_local(wav), "Hallo")
        self.assertEqual(model.language, "de")
        self.assertEqual(len(model.audio), 16000)

    def test_rule_based_answer_works_without_llm(self):
        with patch.object(server, "ollama_ready", return_value=False):
            self.assertEqual(
                server.answer("Hallo"),
                "Hallo! Schön, dass du da bist. Wie kann ich dir helfen?",
            )


if __name__ == "__main__":
    unittest.main()
