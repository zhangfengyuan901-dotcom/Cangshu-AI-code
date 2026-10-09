# PIKNO brand.6 deployment

Upload these three files to the same temporary directory in the ECS Workbench:

- `pikno-new-api-brand6.tar`
- `compose.yaml`
- `deploy-brand6-image.sh`

Then run as `root`:

```bash
chmod 700 deploy-brand6-image.sh
./deploy-brand6-image.sh
```

The script loads the pre-verified image, backs up the current Compose definition,
recreates only the `new-api` service, waits for its health check, and verifies the
embedded version. If deployment fails, it restores the previous Compose definition
and attempts to restart the prior application image.

Expected final line:

```text
PIKNO brand.6 deployed successfully
```

After deployment, verify `https://www.piknoai.com/sign-in` in a private browser
window and test both the login and email-registration pages. No database or secret
file is included in this bundle.
