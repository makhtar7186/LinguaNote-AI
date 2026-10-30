import pytest
from live_audio import silence, tone

from app.live.segmenter import FRAME_BYTES, FRAME_SECONDS, SegmenterConfig, UtteranceSegmenter, frame_rms


def loud_frames(pcm: bytes, threshold: float = SegmenterConfig().speech_rms) -> int:
    usable = len(pcm) - len(pcm) % FRAME_BYTES
    return sum(1 for o in range(0, usable, FRAME_BYTES) if frame_rms(pcm[o:o + FRAME_BYTES]) >= threshold)


def run(segmenter: UtteranceSegmenter, audio: bytes, chunk: int = 3200):
    finished = []
    for offset in range(0, len(audio), chunk):
        finished.extend(segmenter.feed(audio[offset:offset + chunk]))
    finished.extend(segmenter.flush())
    return finished


def test_silence_alone_produces_nothing():
    assert run(UtteranceSegmenter(), silence(5)) == []


def test_one_spoken_burst_becomes_one_utterance_ended_by_the_silence():
    segmenter = UtteranceSegmenter()
    finished = segmenter.feed(silence(0.5) + tone(1.0) + silence(1.0))
    assert len(finished) == 1
    utterance = finished[0]
    assert utterance.utterance_id == 1
    # Starts at most the pre-roll before the first loud frame (0.5 s), ends shortly after the last one.
    assert 0.25 <= utterance.start_seconds <= 0.5
    assert 1.45 <= utterance.end_seconds <= 1.95
    assert loud_frames(utterance.pcm) == loud_frames(tone(1.0))


def test_two_utterances_do_not_overlap_and_ids_increase():
    finished = run(UtteranceSegmenter(), tone(1.0) + silence(1.2) + tone(1.0) + silence(1.2))
    assert [u.utterance_id for u in finished] == [1, 2]
    assert finished[0].end_seconds <= finished[1].start_seconds


def test_a_very_short_burst_is_ignored_and_does_not_consume_an_id():
    finished = run(UtteranceSegmenter(), tone(0.06) + silence(1.0) + tone(1.0) + silence(1.0))
    assert [u.utterance_id for u in finished] == [1]


def test_flush_finishes_the_utterance_in_progress():
    segmenter = UtteranceSegmenter()
    assert segmenter.feed(tone(1.0)) == []
    finished = segmenter.flush()
    assert len(finished) == 1 and loud_frames(finished[0].pcm) == loud_frames(tone(1.0))
    assert segmenter.flush() == []


def test_forced_cut_happens_at_the_quiet_point_and_keeps_every_speech_sample():
    config = SegmenterConfig(max_utterance_seconds=15.0, endpoint_silence_seconds=0.7)
    # 14 s speech, a 0.1 s dip (shorter than the endpoint silence), then more speech.
    audio = tone(14.0) + silence(0.1) + tone(3.0) + silence(1.0)
    finished = run(UtteranceSegmenter(config), audio)
    assert len(finished) == 2
    assert 14.0 <= finished[0].end_seconds <= 14.5  # cut at the dip, not at 15 s
    assert finished[0].end_seconds <= finished[1].start_seconds + FRAME_SECONDS
    assert sum(loud_frames(u.pcm) for u in finished) == loud_frames(audio)


def test_forced_cut_in_continuous_speech_loses_and_repeats_nothing():
    audio = tone(40.0)
    finished = run(UtteranceSegmenter(), audio)
    assert len(finished) >= 3
    assert sum(loud_frames(u.pcm) for u in finished) == loud_frames(audio)
    for before, after in zip(finished, finished[1:], strict=False):
        assert before.end_seconds <= after.start_seconds + FRAME_SECONDS
    assert [u.utterance_id for u in finished] == list(range(1, len(finished) + 1))


@pytest.mark.parametrize("chunk", [2, 640, 641 * 2, 3200, 16000 * 2])
def test_result_does_not_depend_on_how_the_audio_is_chunked(chunk):
    audio = silence(0.3) + tone(2.0) + silence(1.0) + tone(1.5) + silence(1.0)
    reference = run(UtteranceSegmenter(), audio, chunk=3200)
    other = run(UtteranceSegmenter(), audio, chunk=chunk)
    assert [(u.utterance_id, u.pcm, u.start_seconds, u.end_seconds) for u in other] == \
        [(u.utterance_id, u.pcm, u.start_seconds, u.end_seconds) for u in reference]


def test_partials_are_paced_and_grow_within_the_same_utterance():
    segmenter = UtteranceSegmenter(SegmenterConfig(partial_interval_seconds=2.0))
    snapshots = []
    for _ in range(50):  # 5 s of speech in 100 ms chunks
        segmenter.feed(tone(0.1))
        partial = segmenter.due_partial()
        if partial:
            snapshots.append(partial)
    assert len(snapshots) == 2
    assert {s.utterance_id for s in snapshots} == {1}
    assert len(snapshots[1].pcm) > len(snapshots[0].pcm)
    assert segmenter.due_partial() is None  # nothing new yet


def test_no_partial_before_speech_is_confirmed():
    segmenter = UtteranceSegmenter()
    segmenter.feed(silence(3.0))
    assert segmenter.due_partial() is None


def test_total_seconds_counts_whole_frames_received():
    segmenter = UtteranceSegmenter()
    segmenter.feed(silence(1.0))
    assert segmenter.total_seconds == pytest.approx(1.0)
