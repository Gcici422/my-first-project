import { lufs, truepeak, lra } from "https://esm.sh/@audio/loudness@1.2.1";

self.addEventListener("message", (event) => {
  const {
    type,
    analysisId,
    channelData,
    sampleRate,
  } = event.data ?? {};

  if (type !== "analyze") {
    return;
  }

  try {
    validateAudioData(channelData, sampleRate);

    const options = { fs: sampleRate };

    reportProgress(analysisId, "lufs", "正在计算综合响度…");
    const integratedLoudness = lufs(channelData, options);

    reportProgress(analysisId, "truepeak", "正在计算 True Peak…");
    const truePeak = truepeak(channelData, options);

    reportProgress(analysisId, "lra", "正在计算 LRA…");
    const loudnessRange = lra(channelData, options);

    self.postMessage({
      type: "result",
      analysisId,
      results: {
        integratedLoudness,
        truePeak,
        loudnessRange,
      },
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      analysisId,
      message: error instanceof Error ? error.message : "Audio analysis failed.",
    });
  }
});

function reportProgress(analysisId, stage, message) {
  self.postMessage({ type: "progress", analysisId, stage, message });
}

function validateAudioData(channelData, sampleRate) {
  const hasValidChannels =
    Array.isArray(channelData) &&
    channelData.length > 0 &&
    channelData.every((channel) => channel instanceof Float32Array && channel.length > 0);

  if (!hasValidChannels || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid audio data received by worker.");
  }
}
