const MAX_PACKAGE_LENGTH = 5000000;
const CELL_CHUNK_LENGTH = 45000;

function doPost(event) {
  try {
    const config = getConfiguration();
    const request = JSON.parse(event.postData.contents);
    if (request.token !== config.accessToken) {
      return jsonResponse({ ok: false, error: "Неверный секретный код доступа к скрипту" });
    }
    if (request.spreadsheetId !== config.spreadsheetId) {
      return jsonResponse({ ok: false, error: "Ссылка ведёт не на ту таблицу, которая подключена к скрипту" });
    }

    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    let dataSheet = spreadsheet.getSheetByName(config.dataSheet);
    if (!dataSheet) {
      dataSheet = spreadsheet.insertSheet(config.dataSheet);
      dataSheet.hideSheet();
    }

    if (request.action === "write") {
      if (typeof request.package !== "string" ||
          request.package.length === 0 ||
          request.package.length > MAX_PACKAGE_LENGTH) {
        return jsonResponse({ ok: false, error: "Размер зашифрованных данных недопустим" });
      }
      const chunks = request.package.match(new RegExp(".{1," + CELL_CHUNK_LENGTH + "}", "g"));
      dataSheet.clearContents();
      dataSheet.getRange(1, 1, chunks.length, 1).setValues(chunks.map(function (chunk) {
        return [chunk];
      }));
      return jsonResponse({ ok: true });
    }
    if (request.action === "read") {
      const lastRow = dataSheet.getLastRow();
      if (lastRow === 0) {
        return jsonResponse({ ok: true, package: "" });
      }
      const encryptedPackage = dataSheet.getRange(1, 1, lastRow, 1).getValues()
        .map(function (row) { return String(row[0]); })
        .join("");
      return jsonResponse({ ok: true, package: encryptedPackage });
    }
    return jsonResponse({ ok: false, error: "Скрипт получил неизвестную команду" });
  } catch (error) {
    return jsonResponse({ ok: false, error: "Не удалось выполнить операцию: " + String(error) });
  }
}

function getConfiguration() {
  const properties = PropertiesService.getScriptProperties();
  return {
    // Секретный код доступа, который blau отправляет вместе с запросом.
    accessToken: getRequiredProperty(properties, "BLAU_ACCESS_TOKEN"),
    // Идентификатор таблицы: часть ссылки между /d/ и /edit.
    spreadsheetId: getRequiredProperty(properties, "BLAU_SPREADSHEET_ID"),
    // Название скрытого листа, в котором хранится только шифротекст.
    dataSheet: getRequiredProperty(properties, "BLAU_DATA_SHEET")
  };
}

function getRequiredProperty(properties, name) {
  const value = properties.getProperty(name);
  if (!value) {
    const labels = {
      BLAU_ACCESS_TOKEN: "секретный код доступа",
      BLAU_SPREADSHEET_ID: "идентификатор таблицы",
      BLAU_DATA_SHEET: "название листа с зашифрованными данными"
    };
    throw new Error("Не заполнено свойство скрипта «" + (labels[name] || name) + "»");
  }
  return value;
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
