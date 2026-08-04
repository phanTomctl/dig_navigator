# dig_navigator

Data Intelligence & Governance (DIG) for Splunk Enterprise.

## Install from GitHub ZIP

1. Download the `main` branch ZIP.
2. Unzip. You should see `default/`, `bin/`, `appserver/`, etc. at the top of the extracted folder (GitHub may name that folder `dig_navigator-main`).
3. Rename the extracted folder to `dig_navigator`.
4. Copy `dig_navigator` into `$SPLUNK_HOME/etc/apps/`.
5. Restart Splunk (or reload the app) and open **Data Intelligence & Governance**.

Do not keep an extra nested `dig_navigator` folder inside the app directory. The folder you place under `etc/apps` must itself contain `default/app.conf`.
