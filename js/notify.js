import * as bootstrap from "bootstrap";

let toastInstance = null;
let toastBodyElement = null;

function ensureToast() {
  if (toastInstance) {
    return;
  }

  let container = document.getElementById("notifyToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "notifyToastContainer";
    container.className =
      "toast-container p-3 top-0 start-50 translate-middle-x position-fixed";
    container.style.zIndex = "1080";
    document.body.appendChild(container);
  }

  const toastElement = document.createElement("div");
  toastElement.id = "notifyToast";
  toastElement.className = "toast";
  toastElement.setAttribute("role", "alert");
  toastElement.setAttribute("aria-live", "assertive");
  toastElement.setAttribute("aria-atomic", "true");
  toastElement.innerHTML = `
    <div class="toast-header bg-danger-subtle">
      <img src="/icons/clusters.svg" class="rounded me-2" />
      <strong class="me-auto">Warning</strong>
      <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
    <div class="toast-body"></div>
  `;
  container.appendChild(toastElement);

  toastBodyElement = toastElement.querySelector(".toast-body");
  toastInstance = bootstrap.Toast.getOrCreateInstance(toastElement);
}

// One shared way for every page to surface an error to the user, instead of
// each page picking its own (console.error, a silent return, a CSS class
// toggle, ...). Builds its own toast on first use, so no page's HTML needs
// to declare the markup up front.
function notifyError(message) {
  ensureToast();
  toastBodyElement.textContent = message;
  toastInstance.show();
}

export { notifyError };
