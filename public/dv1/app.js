const form = document.querySelector("#plan-form");
const input = document.querySelector("#order-number");
const exampleButton = document.querySelector("#example-order");
const message = document.querySelector("#message");
const result = document.querySelector("#result");

exampleButton.addEventListener("click", () => {
  input.value = "WS-#10001";
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Loading order and calculating a recommendation…", "loading");
  result.hidden = true;

  try {
    const response = await fetch("/dv1/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: input.value })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Unable to plan this order.");
    }

    renderPlan(body);
    setMessage("Recommendation ready for operator review.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

function renderPlan({ order, plan }) {
  const shipmentCards = plan.shipments.map((shipment) => `
    <article class="shipment-card">
      <div class="shipment-heading">
        <div>
          <p class="eyebrow">Fulfillment ${shipment.shipmentIndex}</p>
          <h3>${escapeHtml(shipment.fulfillmentName)}</h3>
        </div>
        <span class="badge ${shipment.containerSku ? "badge-carton" : "badge-solo"}">${shipment.containerSku ? escapeHtml(shipment.containerSku) : "Solo shipment"}</span>
      </div>
      <p class="warehouse">Warehouse: <strong>${escapeHtml(shipment.warehouseId)}</strong></p>
      <ul>${shipment.lines.map((line) => `<li><strong>${escapeHtml(line.sku)}</strong> × ${line.quantity}</li>`).join("")}</ul>
      <p class="reason">${escapeHtml(shipment.reasons.join(" "))}</p>
    </article>
  `).join("");

  const exceptions = plan.exceptions.length
    ? `<div class="warning"><h3>Review before acting</h3><ul>${plan.exceptions.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul></div>`
    : `<div class="success-panel">No planner exceptions. Recheck the live Eccang and Surpath state before making changes.</div>`;

  const ignored = plan.ignoredLines.length
    ? `<p class="muted">Ignored non-AA lines: ${plan.ignoredLines.map((line) => `${escapeHtml(line.sku)} × ${line.quantity}`).join(", ")}</p>`
    : "";

  result.innerHTML = `
    <div class="result-heading">
      <div>
        <p class="eyebrow">Planning result</p>
        <h2>${escapeHtml(order.orderNumber)}</h2>
        <p class="muted">Planner status: <strong>${escapeHtml(plan.status)}</strong> · Preferred warehouse: ${escapeHtml(order.warehouseId)}</p>
      </div>
      <span class="status ${plan.status === "ready" ? "status-ready" : "status-review"}">${escapeHtml(plan.status.replace("_", " "))}</span>
    </div>
    ${exceptions}
    <div class="shipments">${shipmentCards}</div>
    ${ignored}
    <div class="operator-note"><strong>Operator step:</strong> use this as a reference while reproducing the split and shipping decisions in Eccang, then verify the resulting records in Surpath.</div>
  `;
  result.hidden = false;
}

function setMessage(text, kind) {
  message.textContent = text;
  message.className = `message ${kind}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
