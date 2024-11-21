import { dfinance_backend } from "./index.js";

const cache = {};
const POLLING_INTERVAL = 10 * 60 * 1000; // 10 minutes

async function fetchExchangeRate(baseAsset) {
  try {
    const result = await dfinance_backend.get_exchange_rates(
      baseAsset,
      [],
      100000000
    );
    // console.log(result);
    if (result && result.Ok) {
      const [price, timestamp] = result.Ok;
      console.log(
        `Exchange rate fetched successfully for ${baseAsset}:`,
        price,
        timestamp
      );

      return price;
    } else {
      console.error(
        `Error fetching price for ${baseAsset}:`,
        result.Err || "Unknown error"
      );
      return null;
    }
  } catch (error) {
    console.error(`Failed to fetch exchange rate for ${baseAsset}:`, error);
    return null;
  }
}

async function updateCacheAndTriggerActions(assets) {
  for (const asset of assets) {
    const newPrice = await fetchExchangeRate(asset);

    if (newPrice !== null) {
      // Update the cache with the new price unconditionally
      console.log(
        `Updating price for ${asset}: Old: ${cache[asset]}, New: ${newPrice}`
      );
      cache[asset] = newPrice;

      // Trigger actions for the asset
    }
  }
  await calculateUserHealthFactor();
}

async function calculateUserHealthFactor() {
  try {
    const allUsers = await dfinance_backend.get_all_users();

    for (const [principal, userData] of allUsers) {
      // Use for...of instead of forEach
      //console.log("Principal:", principal.toText());

      const reserves = userData.reserves || [];
      // console.log("Reserves:", reserves);

      let totalCollateral = 0;
      let totalDebt = 0;
      let largestBorrowAsset = { asset: null, value: 0 };
      let largestCollateralAsset = { asset: null, value: 0 };

      // Flatten and process reserves
      for (const reserveArray of reserves) {
        // Navigate outer array
        for (const reserve of reserveArray) {
          // Navigate inner reserves
          const reserveAsset = reserve[0]; // Extract asset name (e.g., 'ckUSDC')
          const userreserveData = reserve[1]; // Extract reserve data object
          console.log("*******Fetching Reserve**********");
          console.log("Processing reserve:", reserveAsset);
          //console.log("Reserve data:", userreserveData);

          // Check if supply_rate key exists
          if (!("supply_rate" in userreserveData)) {
            console.error(
              `Missing "supply_rate" for reserve: ${reserveAsset}`,
              userreserveData
            );
            continue; // Skip this reserve if "supply_rate" is missing
          }

          // Proceed with valid reserves
          const supplyRate = userreserveData.supply_rate;
          //console.log(`Supply rate for ${reserveAsset}:`, supplyRate);

          // Fetch normalized income and debt
          const normalizedIncome =
            await dfinance_backend.user_normalized_supply(userreserveData);
          const normalizedDebt = await dfinance_backend.user_normalized_debt(
            userreserveData
          );

          const assetPrice = cache[reserveAsset] || 0; // Use cached price
          console.log(
            `Normalized Income for ${reserveAsset}:`,
            normalizedIncome.Ok * userreserveData.asset_supply
          );
          console.log(
            `Normalized Debt for ${reserveAsset}:`,
            normalizedDebt.Ok
          );
          console.log(`Asset price for ${reserveAsset}:`, assetPrice);

          // Process collateral
          if (userreserveData.is_collateral) {
            const collateralValue = Math.round(
              (((Number(normalizedIncome.Ok) * Number(assetPrice)) / 1e8) *
                Number(userreserveData.asset_supply)) /
                1e8
            );

            totalCollateral += collateralValue;

            if (collateralValue > largestCollateralAsset.value) {
              largestCollateralAsset = {
                asset: reserveAsset,
                value: collateralValue,
              };
            }
          }

          // Process debt
          const debtValue = Math.round(
            (((Number(normalizedDebt.Ok) * Number(assetPrice)) / 1e8) *
              Number(userreserveData.asset_borrow)) /
              1e8
          );

          totalDebt += debtValue;

          if (debtValue > largestBorrowAsset.value) {
            largestBorrowAsset = { asset: reserveAsset, value: debtValue };
          }
        }
      }

      const position = {
        total_collateral_value: totalCollateral,
        total_borrowed_value: totalDebt,
        liquidation_threshold: userData.liquidation_threshold,
      };

      const healthFactor = calculateHealthFactor(position);

      console.log(`User ${principal} Health Factor (h.f): ${healthFactor}`);

      if (healthFactor < 1e8) {
        console.log(`User ${principal} is at risk of liquidation!`);

        const borrowAsset = Array.isArray(largestBorrowAsset.asset)
          ? largestBorrowAsset.asset[0]
          : largestBorrowAsset.asset;
        const collateralAsset = Array.isArray(largestCollateralAsset.asset)
          ? largestCollateralAsset.asset[0]
          : largestCollateralAsset.asset;

        const principalText = principal.toText();

        console.log("Largest Borrow Asset:", borrowAsset);
        console.log("Largest Collateral Asset:", collateralAsset);
        console.log("Principal:", principalText);
        console.log("Value:", largestBorrowAsset.value);

        try {
          const result = await dfinance_backend.liquidation_call(
            borrowAsset,
            collateralAsset,
            largestBorrowAsset.value,
            principalText
          );

          console.log(`Liquidation result for ${principalText}:`, result);
        } catch (error) {
          console.error(
            `Error during liquidation call for ${principalText}:`,
            error
          );
        }
      }

      console.log("*************");
    }
  } catch (error) {
    console.error(`Error fetching users by asset:`, error);
  }
}

async function startPriceMonitoring(assets) {
  console.log("Starting price monitoring...");

  await updateCacheAndTriggerActions(assets);

  setInterval(async () => {
    console.log("Checking for price updates...");
    await updateCacheAndTriggerActions(assets);
  }, POLLING_INTERVAL);
}

const assets = ["ICP", "ckBTC", "ckETH", "ckUSDC", "ckUSDT"];

// Start the monitoring process
startPriceMonitoring(assets);

function calculateHealthFactor(position) {
  const {
    total_collateral_value,
    total_borrowed_value,
    liquidation_threshold,
  } = position;
  if (total_borrowed_value === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (
    (total_collateral_value * liquidation_threshold) / total_borrowed_value
  );
}