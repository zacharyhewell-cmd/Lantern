import { FedExClient } from "./client.js";
import { normalizeFedExTracking } from "./normalize.js";

function statusFromFedEx(fedExTracking, fallbackStatus) {
  const latestDescription = fedExTracking?.latestEvent?.description || fedExTracking?.status || "";
  if (/^shipment information sent/i.test(latestDescription)) {
    return "Waiting for pickup";
  }

  if (/^delivered\b/i.test(latestDescription)) {
    return "Delivered";
  }

  if (fedExTracking) {
    return "In Transit";
  }

  return fallbackStatus;
}

function deliveredAtFromFedEx(fedExTracking, fallbackDeliveredAt) {
  const latestDescription = fedExTracking?.latestEvent?.description || fedExTracking?.status || "";
  if (/^delivered\b/i.test(latestDescription)) {
    return fedExTracking.latestEvent?.scanTime || fallbackDeliveredAt || null;
  }

  return null;
}

export async function enrichSummaryWithFedEx(summary, fedExConfig, fetchImpl = globalThis.fetch) {
  const client = new FedExClient(fedExConfig, fetchImpl);
  if (!client.isConfigured() || !summary?.shipments?.length) {
    return summary;
  }

  const enrichedShipments = [];
  for (const shipment of summary.shipments) {
    const enrichedTracking = [];
    let shipmentStatus = shipment.status;
    let deliveredAt = shipment.deliveredAt;
    let estimatedDeliveryAt = shipment.estimatedDeliveryAt;

    for (const tracking of shipment.tracking) {
      if (tracking.carrier !== "FedEx" || !tracking.trackingNumber) {
        enrichedTracking.push(tracking);
        continue;
      }

      try {
        const response = await client.trackByTrackingNumber(tracking.trackingNumber);
        const fedExTracking = normalizeFedExTracking(response);
        shipmentStatus = statusFromFedEx(fedExTracking, shipmentStatus);
        deliveredAt = deliveredAtFromFedEx(fedExTracking, deliveredAt);
        estimatedDeliveryAt = shipmentStatus === "Delivered" ? null : (fedExTracking?.estimatedDelivery || estimatedDeliveryAt);
        enrichedTracking.push({
          ...tracking,
          fedEx: fedExTracking,
        });
      } catch (error) {
        enrichedTracking.push({
          ...tracking,
          enrichmentError: error.message,
        });
      }
    }

    enrichedShipments.push({
      ...shipment,
      status: shipmentStatus,
      deliveredAt,
      estimatedDeliveryAt,
      tracking: enrichedTracking,
    });
  }

  return {
    ...summary,
    shipments: enrichedShipments,
  };
}
