const tg = window.Telegram?.WebApp;

function cleanInn(v){
  return (v || "").replace(/\D/g, "").slice(0, 12);
}

function isInnValid(inn){
  return inn.length === 10 || inn.length === 12;
}

function setPill(text){
  const el = document.getElementById("envPill");
  if (el) el.textContent = text;
}

document.addEventListener("DOMContentLoaded", () => {
  const innEl = document.getElementById("inn");
  const goEl = document.getElementById("go");

  if (tg){
    tg.ready();
    tg.expand();
    setPill("TELEGRAM");
  } else {
    setPill("WEB");
  }

  innEl.addEventListener("input", () => {
    innEl.value = cleanInn(innEl.value);
  });

  function submit(){
    const inn = cleanInn(innEl.value);
    innEl.value = inn;

    if (!isInnValid(inn)){
      if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
      alert("ИНН должен быть 10 или 12 цифр.");
      return;
    }

    const payload = JSON.stringify({ type: "inn_check", inn });

    // Отправляем данные в бота (в чат), чтобы бот уже отвечал сообщением
    if (tg?.sendData){
      tg.sendData(payload);
      if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      tg.close();
    } else {
      alert("Откройте это внутри Telegram, чтобы отправить ИНН боту.");
    }
  }

  goEl.addEventListener("click", submit);
  innEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
});
