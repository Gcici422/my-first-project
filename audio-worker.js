import { lufs, truepeak, lra } from "https://esm.sh/@audio/loudness@1.2.1";

self.addEventListener("message", (event) => {
  const { type, channelData, sampleRate } = event.data ?? {};

  if (type !== "analyze") {
    return;
  }

  try {
    validateAudioData(channelData, sampleRate);

    const options = { fs: sampleRate };

    reportProgress("正在计算响度…");
    const integratedLoudness = lufs(channelData, options);

    reportProgress("正在计算 True Peak…");
    const truePeak = truepeak(channelData, options);

    reportProgress("正在计算 LRA…");
    const loudnessRange = lra(channelData, options);

    self.postMessage({
      type: "result",
      results: {
        integratedLoudness,
        truePeak,
        loudnessRange,
      },
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Audio analysis failed.",
    });
  }
});

function reportProgress(message) {
  self.postMessage({ type: "progress", message });
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
