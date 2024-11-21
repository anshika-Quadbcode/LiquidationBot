

//TODO give an identity to the bot (principal)
//is THE reward will be recieved on platform or the wallet
//TODO handle large set of users - batches, promises, parallel processesing


// MY IDEA - we will create a api , one who need to use this api will need to send there principal(act as caller) to it, we verify it from the list of liquidators or something
//then he will got all the user info who are under liq - only those whose repay amount is less then liquidator balance
//then he can just click on call liquidation with that user principal


//change liq_call logic for auto liq by platform

// PROBLEM is create actor without backend.did - athaarv
// import { dfinance_backend } from "./index.js";



import { dfinance_backend } from "./index.js";

const cache = {};
const POLLING_INTERVAL = 10 * 60 * 1000; // 10 minutes


async function fetchExchangeRate(baseAsset) {
  try {
    const result = await dfinance_backend.get_exchange_rates(baseAsset, [], 100000000);
    // console.log(result);
    if (result && result.Ok) {
      const [price, timestamp] = result.Ok;
      console.log(`Exchange rate fetched successfully for ${baseAsset}:`, price, timestamp);

     
      return price;
    } else {
      console.error(`Error fetching price for ${baseAsset}:`, result.Err || "Unknown error");
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
      if (!cache[asset] || cache[asset] !== newPrice) {
        console.log(`Price change detected for ${asset}: Old: ${cache[asset]}, New: ${newPrice}`);
        cache[asset] = newPrice;

        
        await fetchUsersByAsset(asset);
      }
    }
  }
}

async function fetchUsersByAsset(asset) {
  try {
    const allUsers = await dfinance_backend.get_all_users();
    // console.log("all users", allUsers);
    const usersWithAsset = allUsers.filter(([principal, userData]) => {
      if (userData.reserves && Array.isArray(userData.reserves)) {
        const reserves = userData.reserves || [];
        // console.log("usereserve", reserves);

      
        const hasAsset = reserves.some(reserve => reserve[0][0] === asset);
        console.log(`User ${principal} has asset ${asset}:`, hasAsset);

        return hasAsset;
      }
      return false;
    });


    usersWithAsset.forEach(async ([principal, userData]) => {
      // console.log("Principal:", principal);
      // console.log("UserData:", JSON.stringify(userData, null, 2));
      //loop all reserves -> call get normalizedincome and getnormalizeddebt multiply it with assetprice from cache 
      //add it up to totalcollateral and totaldebt 
      //pass it to h.f formula
      console.log(`Users using ${asset} as collateral or debt:`, principal);

      const reserves = userData.reserves || [];
      let totalCollateral = 0;
      let totalDebt = 0;
      let largestBorrowAsset = { asset: null, value: 0 };
      let largestCollateralAsset = { asset: null, value: 0 };
      //max debt asset, max collateral asset
      for (const reserve of reserves) {
        const [reserveAsset] = reserve[0];
         console.log('reservename', [reserveAsset]);
        const userreserveData = reserve[0][1];
        console.log('user reserve data', userreserveData);
        const normalizedIncome = await dfinance_backend.user_normalized_supply(reserve[0][1]);
        const normalizedDebt = await dfinance_backend.user_normalized_debt(reserve[0][1]);

        const assetPrice = cache[reserveAsset] || 0; // Use cached price
        console.log(`Normalized Income for ${reserveAsset}:`, normalizedIncome.Ok*userreserveData.asset_supply);
        console.log(`Normalized Debt for ${reserveAsset}:`, normalizedDebt.Ok);
        console.log(`Asset price for ${reserveAsset}:`, assetPrice);

        console.log("type",typeof(normalizedIncome.Ok),typeof(assetPrice),typeof(totalCollateral))
        //totalSupply  += BigInt(normalizedIncome.Ok) * BigInt(assetPrice);
        //if userreserve.iscollateral { totalCollateral}
        if (userreserveData.is_collateral) {
          const collateralValue = Math.round(
            ((Number(normalizedIncome.Ok) * Number(assetPrice)) / 1e8 * Number(userreserveData.asset_supply)) / 1e8
          );
        
          totalCollateral += collateralValue;
        
          if (collateralValue > largestCollateralAsset.value) {
            largestCollateralAsset = { asset: [reserveAsset], value: collateralValue };
          }
        }
        
        const debtValue = Math.round(
          ((Number(normalizedDebt.Ok) * Number(assetPrice)) / 1e8 * Number(userreserveData.asset_borrow)) / 1e8
        );
        
        totalDebt += debtValue;
        
        if (debtValue > largestBorrowAsset.value) {
          largestBorrowAsset = { asset:[reserveAsset], value: debtValue };
        }

      }

      console.log(`User ${principal} Total Collateral: ${totalCollateral}, Total Debt: ${totalDebt}`);
console.log("LiquidationThreshold",userData. liquidation_threshold)
      const position = {
        total_collateral_value: totalCollateral, // Replace with the actual collateral value
        total_borrowed_value: totalDebt,         // Replace with the actual borrowed value
        liquidation_threshold: userData. liquidation_threshold              // Replace with your liquidation threshold
      };
      
      const healthFactor = calculateHealthFactor(position);
      
      console.log(`User ${principal} Health Factor (h.f): ${healthFactor}`);

      if (healthFactor > 1e8) {
        console.log(`User ${principal} is at risk of liquidation!`);
      
        
        const borrowAsset = Array.isArray(largestBorrowAsset.asset) ? largestBorrowAsset.asset[0] : largestBorrowAsset.asset;
        const collateralAsset = Array.isArray(largestCollateralAsset.asset) ? largestCollateralAsset.asset[0] : largestCollateralAsset.asset;
      
       
        const principalText = principal.toText();
      
        console.log("Largest Borrow Asset:", borrowAsset);
        console.log("Largest Collateral Asset:", collateralAsset);
        console.log("Principal:", principalText);
      
        try {
          const result = await dfinance_backend.liquidation_call(
            borrowAsset,         
            collateralAsset,     
            largestBorrowAsset.value, 
            principalText       
          );
      
          console.log(`Liquidation result for ${principalText}:`, result);
        } catch (error) {
          console.error(`Error during liquidation call for ${principalText}:`, error);
        }
      } 
    });
  } catch (error) {
    console.error(`Error fetching users by asset ${asset}:`, error);
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
  const { total_collateral_value, total_borrowed_value, liquidation_threshold } = position;
  if (total_borrowed_value === 0) {
    return Number.MAX_SAFE_INTEGER; 
  }
  return (total_collateral_value * liquidation_threshold) / total_borrowed_value;
}

//getuserstate
//exchange rate outside the getUserAccountData, cal it using
//recalculate total collateral in base currency and total debt -> getUserAccountData

//cal. health factor - 