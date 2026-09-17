import decode from "https://esm.sh/@audio/decode@3.15.0";

const supportedExtensions = new Set(["wav", "mp3", "flac"]);
const progressStages = ["read", "decode", "lufs", "truepeak", "lra", "complete"];

let nextAnalysisId = 0;
let activeAnalysis = null;

const elements = {
  chooseButton: document.querySelector("#choose-file"),
  cancelButton: document.querySelector("#cancel-analysis"),
  fileInput: document.querySelector("#audio-file"),
  statusPanel: document.querySelector("#status-panel"),
  statusText: document.querySelector("#status-text"),
  progressPanel: document.querySelector("#analysis-progress"),
  progressSteps: [...document.querySelectorAll("[data-progress-stage]")],
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

class AnalysisCancelledError extends Error {
  constructor() {
    super("Audio analysis was cancelled.");
    this.name = "AnalysisCancelledError";
  }
}

class WorkerAnalysisError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerAnalysisError";
  }
}

elements.chooseButton.addEventListener("click", () => {
  elements.fileInput.click();
});

elements.cancelButton.addEventListener("click", () => {
  cancelActiveAnalysis();
});

elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";

  if (!file) {
    return;
  }

  if (activeAnalysis) {
    cancelActiveAnalysis({ announce: false });
  }

  resetOutput();
  elements.fileName.textContent = file.name;
  elements.filePanel.hidden = false;

  if (!isSupportedFile(file)) {
    showError("请选择有效的 WAV、MP3 或 FLAC 音频文件。");
    setStatus("无法分析此文件格式", "error");
    return;
  }

  const analysis = createAnalysis();
  setBusy(true);
  elements.progressPanel.hidden = false;
  elements.cancelButton.hidden = false;
  setProgressStage("read");
  setStatus("正在读取文件…", "loading");

  try {
    await waitForPaint();
    assertActiveAnalysis(analysis);

    let encodedAudio = await file.arrayBuffer();
    assertActiveAnalysis(analysis);

    setProgressStage("decode");
    setStatus("正在解码音频…", "loading");
    await waitForPaint();
    assertActiveAnalysis(analysis);

    const decodedAudio = await decode(encodedAudio);
    encodedAudio = null;
    assertActiveAnalysis(analysis);

    const { channelData, sampleRate } = decodedAudio;

    if (!isValidAudioData(channelData, sampleRate)) {
      throw new Error("Decoded audio data is empty or invalid.");
    }

    const channelCount = channelData.length;
    const duration = channelData[0].length / sampleRate;

    elements.durationValue.textContent = formatDuration(duration);
    elements.sampleRateValue.textContent = sampleRate.toLocaleString("zh-CN");
    elements.channelsValue.textContent = String(channelCount);
    elements.results.hidden = false;

    analysis.phase = "worker";
    const { integratedLoudness, truePeak, loudnessRange } = await analyzeInWorker(
      channelData,
      sampleRate,
      analysis,
    );
    assertActiveAnalysis(analysis);

    elements.integratedValue.textContent = formatMetric(integratedLoudness);
    elements.truePeakValue.textContent = formatMetric(truePeak);
    elements.lraValue.textContent = formatMetric(loudnessRange);
    setProgressStage("complete");
    setStatus("分析完成", "success");
  } catch (error) {
    if (error instanceof AnalysisCancelledError || !isActiveAnalysis(analysis)) {
      return;
    }

    console.error("Audio analysis failed:", error);
    markProgressStopped("error");

    if (analysis.phase === "worker") {
      showError("响度计算失败，请稍后重试或选择其他音频文件。");
      setStatus("响度计算失败", "error");
    } else {
      showError("无法读取或解码该音频文件，请确认文件完整且格式正确后重试。");
      setStatus("文件解码失败", "error");
    }
  } finally {
    if (isActiveAnalysis(analysis)) {
      activeAnalysis = null;
      setBusy(false);
      elements.cancelButton.hidden = true;
    }
  }
});

function createAnalysis() {
  const analysis = {
    id: ++nextAnalysisId,
    phase: "file",
    cancelled: false,
    worker: null,
    cancelWorker: null,
  };

  activeAnalysis = analysis;
  return analysis;
}

function cancelActiveAnalysis({ announce = true } = {}) {
  const analysis = activeAnalysis;

  if (!analysis) {
    return;
  }

  analysis.cancelled = true;
  activeAnalysis = null;

  if (typeof analysis.cancelWorker === "function") {
    analysis.cancelWorker();
  } else if (analysis.worker) {
    analysis.worker.terminate();
    analysis.worker = null;
  }

  setBusy(false);
  elements.cancelButton.hidden = true;
  hideError();

  if (announce) {
    markProgressStopped("cancelled");
    setStatus("分析已取消", "cancelled");
  }
}

function isActiveAnalysis(analysis) {
  return activeAnalysis?.id === analysis.id && !analysis.cancelled;
}

function assertActiveAnalysis(analysis) {
  if (!isActiveAnalysis(analysis)) {
    throw new AnalysisCancelledError();
  }
}

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

function analyzeInWorker(channelData, sampleRate, analysis) {
  return new Promise((resolve, reject) => {
    if (!isActiveAnalysis(analysis)) {
      reject(new AnalysisCancelledError());
      return;
    }

    let worker;

    try {
      worker = new Worker("./audio-worker.js", { type: "module" });
    } catch (error) {
      reject(new WorkerAnalysisError(error.message || "Unable to start audio analysis worker."));
      return;
    }

    analysis.worker = worker;
    let isFinished = false;

    const finish = (callback) => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      worker.terminate();

      if (analysis.worker === worker) {
        analysis.worker = null;
      }

      if (analysis.cancelWorker === cancelWorker) {
        analysis.cancelWorker = null;
      }

      callback();
    };

    const cancelWorker = () => {
      finish(() => reject(new AnalysisCancelledError()));
    };

    analysis.cancelWorker = cancelWorker;

    worker.addEventListener("message", (event) => {
      const {
        analysisId,
        type,
        stage,
        message,
        results,
      } = event.data ?? {};

      if (analysisId !== analysis.id || !isActiveAnalysis(analysis)) {
        return;
      }

      if (type === "progress" && progressStages.includes(stage) && typeof message === "string") {
        setProgressStage(stage);
        setStatus(message, "loading");
        return;
      }

      if (type === "result") {
        finish(() => resolve(results));
        return;
      }

      if (type === "error") {
        finish(() => reject(new WorkerAnalysisError(message || "Audio analysis worker failed.")));
      }
    });

    worker.addEventListener("error", (event) => {
      if (!isActiveAnalysis(analysis)) {
        cancelWorker();
        return;
      }

      finish(() => {
        reject(new WorkerAnalysisError(event.message || "Unable to start audio analysis worker."));
      });
    });

    const transferList = [...new Set(channelData.map((channel) => channel.buffer))];

    try {
      worker.postMessage(
        {
          type: "analyze",
          analysisId: analysis.id,
          channelData,
          sampleRate,
        },
        transferList,
      );
    } catch (error) {
      finish(() => {
        reject(new WorkerAnalysisError(error.message || "Unable to send audio to worker."));
      });
    }
  });
}

function setProgressStage(stage) {
  const activeIndex = progressStages.indexOf(stage);

  if (activeIndex === -1) {
    return;
  }

  elements.progressSteps.forEach((step, index) => {
    step.classList.remove("is-active", "is-complete", "is-cancelled", "is-error");
    step.removeAttribute("aria-current");

    if (stage === "complete" || index < activeIndex) {
      step.classList.add("is-complete");
    } else if (index === activeIndex) {
      step.classList.add("is-active");
      step.setAttribute("aria-current", "step");
    }
  });
}

function markProgressStopped(state) {
  const activeStep = elements.progressSteps.find((step) => step.classList.contains("is-active"));

  if (!activeStep) {
    return;
  }

  activeStep.classList.remove("is-active");
  activeStep.classList.add(state === "cancelled" ? "is-cancelled" : "is-error");
  activeStep.removeAttribute("aria-current");
}

function resetProgress() {
  elements.progressPanel.hidden = true;
  elements.cancelButton.hidden = true;

  elements.progressSteps.forEach((step) => {
    step.classList.remove("is-active", "is-complete", "is-cancelled", "is-error");
    step.removeAttribute("aria-current");
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

function hideError() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = "";
}

function resetOutput() {
  hideError();
  resetProgress();
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
