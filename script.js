const testButton = document.querySelector("#test-button");
const message = document.querySelector("#message");

testButton.addEventListener("click", () => {
  message.textContent = "Hello from Codex!";
});
