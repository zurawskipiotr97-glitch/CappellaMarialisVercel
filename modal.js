// modal.js (PRO)
// Jeśli link ma data-open="new-tab", nie przechwytuj kliknięcia
document.addEventListener("click", function (e) {
  const link = e.target.closest(".open-recording-modal");
  if (!link) return;

  if (link.dataset.open === "new-tab") {
    return; // pozwól przeglądarce otworzyć nową kartę
  }

  e.preventDefault();
  const url = link.dataset.modalUrl;
  if (!url) return;

  // tu normalna logika modala
});
