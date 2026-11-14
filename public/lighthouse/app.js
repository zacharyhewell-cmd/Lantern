const form = document.querySelector("#lookup-form");
const input = document.querySelector("#order-number");
const postalCodeInput = document.querySelector("#postal-code");
const button = form.querySelector("button");
const statusPanel = document.querySelector("#status");
const result = document.querySelector("#result");
const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#sign-out");
const instructions = document.querySelector("#instructions");
const setupForm = document.querySelector("#setup-form");
const setupToken = new URLSearchParams(window.location.hash.slice(1)).get("setup");
let viewVersion = 0;

function setSignedIn(signedIn) {
  viewVersion += 1;
  form.hidden = !signedIn;
  logoutButton.hidden = !signedIn;
  loginForm.hidden = signedIn;
  instructions.textContent = signedIn
    ? "Enter an order number and shipping postal code to review its tracking details."
    : "Sign in to Lighthouse to track your orders.";
  if (!signedIn) {
    form.reset();
    result.replaceChildren();
    result.hidden = true;
  }
}

async function changeSession(method, body) {
  const response = await fetch("/lighthouse/session", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "We could not update your sign-in.");
  return data;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector("button");
  const email = loginForm.elements.email.value;
  const password = loginForm.elements.password.value;
  loginForm.elements.password.value = "";
  submit.disabled = true;
  showStatus("Signing in…");
  try {
    const { signedIn } = await changeSession("POST", { email, password });
    setSignedIn(signedIn);
    hideStatus();
    input.focus();
  } catch (error) {
    showStatus(error.message, "error");
    loginForm.elements.password.focus();
  } finally {
    submit.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  button.disabled = true;
  viewVersion += 1;
  result.replaceChildren();
  result.hidden = true;
  try {
    await changeSession("DELETE");
    setSignedIn(false);
    hideStatus();
    loginForm.elements.email.focus();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    logoutButton.disabled = false;
    button.disabled = false;
  }
});

if (setupToken) {
  history.replaceState(null, "", location.pathname + location.search);
  setupForm.hidden = false;
  instructions.textContent = "Choose a password for Lighthouse. Use at least 15 characters.";
} else {
  changeSession("GET").then(({ signedIn }) => setSignedIn(signedIn)).catch(() => setSignedIn(false));
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = setupForm.elements.password.value;
  if (password !== setupForm.elements.confirmation.value) {
    showStatus("The passwords don't match.", "error");
    return;
  }
  const submit = setupForm.querySelector("button");
  submit.disabled = true;
  showStatus("Setting your password…");
  try {
    const response = await fetch("/lighthouse/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: setupToken, password }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setupForm.reset();
    setupForm.hidden = true;
    setSignedIn(false);
    showStatus("Your Lighthouse password is set. Sign in to track your orders.");
    loginForm.elements.email.focus();
  } catch (error) {
    showStatus(error.message || "We could not set your password.", "error");
  } finally {
    submit.disabled = false;
  }
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showStatus(message, kind = "info") {
  statusPanel.className = `status-panel status-${kind}`;
  statusPanel.textContent = message;
  statusPanel.hidden = false;
}

function hideStatus() {
  statusPanel.hidden = true;
}

function formatDate(value, includeTime = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
    timeZone: "America/Los_Angeles",
  }).format(date);
}

function addDetail(container, label, value) {
  if (!value) return;
  const row = element("p", "detail");
  const detailValue = element("span", "detail-value");
  detailValue.append(value);
  row.append(element("span", "detail-label", label), detailValue);
  container.append(row);
}

function itemLines(items) {
  return element("span", "item-lines", items.map((item) => (
    `${item.quantity}x ${item.name}`
  )).join("\n"));
}

function renderTracking(container, tracking) {
  addDetail(container, "Carrier", tracking.carrier);

  if (tracking.trackingNumber) {
    if (tracking.trackingUrl) {
      const link = element("a", null, tracking.trackingNumber);
      link.href = tracking.trackingUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      addDetail(container, "Tracking", link);
    } else {
      addDetail(container, "Tracking", tracking.trackingNumber);
    }
  }

  if (tracking.latestUpdate) {
    const update = tracking.latestUpdate;
    const parts = [update.description, update.location, formatDate(update.time, true)].filter(Boolean);
    addDetail(container, "Latest update", parts.join(", "));
  }
}

function renderShipment(shipment, index, total) {
  const card = element("article", "shipment-card");
  const header = element("div", "shipment-header");
  header.append(
    element("p", "shipment-label", total > 1 ? `Shipment ${index + 1}` : "Shipment"),
    element("span", "status-chip", shipment.status),
  );
  card.append(header);

  if (shipment.items.length) addDetail(card, "Items", itemLines(shipment.items));
  if (shipment.deliveredAt) {
    addDetail(card, "Delivered", formatDate(shipment.deliveredAt, true));
  } else if (shipment.estimatedDeliveryAt) {
    addDetail(card, "Estimated delivery", formatDate(shipment.estimatedDeliveryAt));
  }

  if (shipment.tracking.length) {
    shipment.tracking.forEach((tracking) => renderTracking(card, tracking));
  } else {
    addDetail(card, "Tracking", "Not available yet");
  }

  return card;
}

function renderOrder(order) {
  result.replaceChildren();

  const heading = element("div", "result-heading");
  heading.append(
    element("p", "eyebrow", "Order found"),
    element("h2", null, order.orderNumber || "Order"),
  );
  result.append(heading);

  if (order.cancelledAt) {
    const cancellation = element("div", "notice notice-critical", `Canceled ${formatDate(order.cancelledAt, true)}`);
    result.append(cancellation);
  }

  if (order.unfulfilledItems.length) {
    const unfulfilled = element("section", "notice");
    const items = element("p");
    items.append(itemLines(order.unfulfilledItems));
    unfulfilled.append(element("h3", null, "Unfulfilled items"), items);
    result.append(unfulfilled);
  }

  const shipments = element("div", "shipments");
  order.shipments.forEach((shipment, index) => {
    shipments.append(renderShipment(shipment, index, order.shipments.length));
  });
  if (!order.shipments.length) {
    shipments.append(element("div", "notice", "No shipment details are available yet."));
  }
  result.append(shipments);

  if (order.warnings.length) {
    const notes = element("section", "notes");
    notes.append(element("h3", null, "Notes"));
    const list = element("ul");
    order.warnings.forEach((warning) => list.append(element("li", null, warning)));
    notes.append(list);
    result.append(notes);
  }

  result.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const orderNumber = input.value.trim();
  const postalCode = postalCodeInput.value.trim();
  if (!orderNumber || !postalCode) return;

  const version = viewVersion;
  button.disabled = true;
  result.hidden = true;
  showStatus("Verifying the latest order information…");

  try {
    const response = await fetch("/lighthouse/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber, postalCode }),
    });
    const body = await response.json();
    if (version !== viewVersion) return;
    if (response.status === 401) setSignedIn(false);

    if (!response.ok) throw new Error(body.error || "The lookup could not be completed.");
    if (!body.found) {
      showStatus("We could not find an order matching that number.", "error");
      return;
    }

    hideStatus();
    renderOrder(body);
  } catch (error) {
    if (version === viewVersion || form.hidden) {
      showStatus(error.message || "The lookup could not be completed.", "error");
    }
  } finally {
    button.disabled = false;
  }
});
