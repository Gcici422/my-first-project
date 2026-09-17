import decode from "https://esm.sh/@audio/decode@3.15.0";

const supportedExtensions = new Set(["wav", "mp3", "flac"]);

const elements = {
  chooseButton: document.querySelector("#choose-file"),
  fileInput: document.querySelector("#audio-file"),
  statusPanel: document.querySelector("#status-panel"),
  statusText: document.querySelector("#status-text"),
  errorMessage: document.querySelector("#error-message"),
  filePanel: document.querySelector("#file-panel"),
  fileName: document.querySelector("#file-name"),
  results: document.querySelector("#results"),
  integratedValue: document.querySelector("#integrated-value"),
  truePeakValue: document.querySelector("#true-peak-value"),
  lraValue: document.querySelector("#lra-value"),
  durationValue: document.querySelector("#duration-value"),
  sampleRateValue: document.querySelector("#sample-rate-value"),
  channelsValue: document.querySelector("#channels-value"),
};

elements.chooseButton.addEventListener("click", () => {
  elements.fileInput.click();
});

elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  resetOutput();
  elements.fileName.textContent = file.name;
  elements.filePanel.hidden = false;

  if (!isSupportedFile(file)) {
    showError("请选择有效的 WAV、MP3 或 FLAC 音频文件。");
    setStatus("无法分析此文件格式", "error");
    elements.fileInput.value = "";
    return;
  }

  setBusy(true);
  setStatus("正在解码音频…", "loading");

  try {
    await waitForPaint();

    const { channelData, sampleRate } = await decode(file);

    if (!isValidAudioData(channelData, sampleRate)) {
      throw new Error("Decoded audio data is empty or invalid.");
    }

    const channelCount = channelData.length;
    const duration = channelData[0].length / sampleRate;

    elements.durationValue.textContent = formatDuration(duration);
    elements.sampleRateValue.textContent = sampleRate.toLocaleString("zh-CN");
    elements.channelsValue.textContent = String(channelCount);
    elements.results.hidden = false;

    const { integratedLoudness, truePeak, loudnessRange } = await analyzeInWorker(
      channelData,
      sampleRate,
    );

    elements.integratedValue.textContent = formatMetric(integratedLoudness);
    elements.truePeakValue.textContent = formatMetric(truePeak);
    elements.lraValue.textContent = formatMetric(loudnessRange);
    setStatus("分析完成", "success");
  } catch (error) {
    console.error("Audio analysis failed:", error);
    showError("无法读取或分析该音频文件，请确认文件完整且格式正确后重试。");
    setStatus("分析失败", "error");
  } finally {
    setBusy(false);
    elements.fileInput.value = "";
  }
});

function isSupportedFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return supportedExtensions.has(extension);
}

function isValidAudioData(channelData, sampleRate) {
  return (
    Array.isArray(channelData) &&
    channelData.length > 0 &&
    channelData.every((channel) => channel instanceof Float32Array && channel.length > 0) &&
    Number.isFinite(sampleRate) &&
    sampleRate > 0
  );
}

function analyzeInWorker(channelData, sampleRate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./audio-worker.js", { type: "module" });
    let isFinished = false;

    const finish = (callback) => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      worker.terminate();
      callback();
    };

    worker.addEventListener("message", (event) => {
      const { type, message, results } = event.data ?? {};

      if (type === "progress" && typeof message === "string") {
        setStatus(message, "loading");
        return;
      }

      if (type === "result") {
        finish(() => resolve(results));
        return;
      }

      if (type === "error") {
        finish(() => reject(new Error(message || "Audio analysis worker failed.")));
      }
    });

    worker.addEventListener("error", (event) => {
      finish(() => reject(new Error(event.message || "Unable to start audio analysis worker.")));
    });

    const transferList = [...new Set(channelData.map((channel) => channel.buffer))];

    try {
      worker.postMessage(
        {
          type: "analyze",
          channelData,
          sampleRate,
        },
        transferList,
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function formatMetric(value) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(1);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;

  if (minutes === 0) {
    return `${remainingSeconds.toFixed(1)}s`;
  }

  return `${minutes}:${remainingSeconds.toFixed(1).padStart(4, "0")}`;
}

function setStatus(message, state) {
  elements.statusText.textContent = message;
  elements.statusPanel.dataset.state = state;
}

function setBusy(isBusy) {
  elements.chooseButton.disabled = isBusy;
  elements.fileInput.disabled = isBusy;
  elements.statusPanel.setAttribute("aria-busy", String(isBusy));
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = false;
}

function resetOutput() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = "";
  elements.results.hidden = true;
  elements.integratedValue.textContent = "--";
  elements.truePeakValue.textContent = "--";
  elements.lraValue.textContent = "--";
  elements.durationValue.textContent = "--";
  elements.sampleRateValue.textContent = "--";
  elements.channelsValue.textContent = "--";
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
