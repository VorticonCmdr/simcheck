const $progress = $("#progress");

/*
change progress bar based on message
string message.status
string message.name
float message.progress between 0 and 100
*/
async function setProgressbar(message) {
  console.log(message);
  if (message.progress || message.finished) {
    if (message.progress < 100) {
      $progress
        .addClass("progress-bar-striped progress-bar-animated")
        .removeClass("bg-success")
        .css("width", `${message.progress}%`)
        .text(
          `${message?.status} ${message?.name} ${message?.progress.toFixed(1)}%`,
        );
    } else {
      $progress
        .removeClass("progress-bar-striped progress-bar-animated")
        .css("width", "100%")
        .text(`${message?.status} ${message?.name} 100%`);
    }

    if (message.finished) {
      $progress
        .addClass("bg-success")
        .css("width", "100%")
        .text(`${message?.status} ${message?.name} 100%`);
    }
  }
}

export { setProgressbar };
