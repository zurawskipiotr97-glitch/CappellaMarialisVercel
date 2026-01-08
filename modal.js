/* Recording modal for ffm.to (static HTML on Vercel) */
(function () {
  const modal = document.getElementById("recording-modal");
  const iframe = document.getElementById("recording-modal-iframe");
  if (!modal || !iframe) return;

  const overlayBtn = modal.querySelector(".recording-modal__overlay");
  const closeBtn = modal.querySelector(".recording-modal__close");

  let lastActiveEl = null;
  let prevBodyOverflow = "";

  function openModal(url) {
    if (!url) return;

    lastActiveEl = document.activeElement;
    prevBodyOverflow = document.body.style.overflow;

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    iframe.src = url;

    if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");

    iframe.src = "about:blank";
    document.body.style.overflow = prevBodyOverflow || "";

    if (lastActiveEl && typeof lastActiveEl.focus === "function") lastActiveEl.focus();
  }

  document.addEventListener("click", (e) => {
    const target = e.target && e.target.closest ? e.target.closest(".open-recording-modal") : null;
    if (!target) return;

    const url = target.getAttribute("data-modal-url") || target.getAttribute("href");
    if (!url) return;

    e.preventDefault();
    openModal(url);
  });

  if (overlayBtn) overlayBtn.addEventListener("click", closeModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  });
})();
