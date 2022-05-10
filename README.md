# [ChartMuseum](https://github.com/kubernetes-helm/chartmuseum/) Resource for [Concourse CI](https://concourse.ci/)

Fetches, verifies and publishes Helm Charts from a running ChartMuseum instance.
[Harbor](https://goharbor.io/) works as well, since it uses ChartMuseum under the hood.

This resource works probably best in conjunction with the [Helm resource](https://github.com/linkyard/concourse-helm-resource)
which can be used to perform Helm deployments into Kubernetes clusters.

## Requirements

* A running ChartMuseum instance (this resource has been tested with v0.9.0)

## Installation

Add a new resource type to your Concourse CI pipeline:

```yaml
resource_types:
- name: chartmuseum
  type: docker-image
  source:
    repository: cathive/concourse-chartmuseum-resource
    tag: latest # For reproducible builds use a specific tag and don't rely on "latest".
```

## Source Configuration

* `server_url`: *Required.* The address of the Chartmuseum/Harbor API. For chartmuseum, this'll be something like `https://chartmuseum.yourdomain.com/api/charts`. For harbor (*which uses chartmuseum but changes the API and path*), this'll be something like `https://harbor.yourdomain.com/api/chartrepo/charts` (*for the default "library" project*) or `https://harbor.yourdomain.com/api/chartrepo/<project name>/charts` for other projects.

* `chart_name`: *Required* The name of the chart to operate upon.

* `version_range`: Optional parameter that can be used to specify a (SemVer) version range
  that must match when checking for new charts, e.g. `=1.2.0`, `^2.0.0`, `~0.2.3` or `*`.

* `basic_auth_username`: Optional username to be used if your ChartMuseum is username/password protected.
  If provided, the paramter `basic_auth_password` must also be specified.

* `basic_auth_password`: Optional password to be used if your ChartMuseum is username/password protected.
  If provided, the paramter `basic_auth_username` must also be specified.

* `harbor_api`: Optional, set to `true` use the Harbor API (*which is different enough to the standard ChartMuseum API not to work*)

* `tls_ca_cert`: CA certificate for the Chartmuseum server

* `tls_client_cert`: Identify HTTPS client using this SSL certificate string

* `tls_client_key`: Identify HTTPS client using this SSL key string

## Behavior

The resource implements all three actions (check, in and out).

### check: Check for new versions of the Helm chart

Checks for new versions of the specified Helm chart.
If a semver version range has been specified in the `source`configuration it will be
honored when checking new versions.

### in: Fetches the chart and (optionally) verifies it's provenance

Places the JSON object that describes the Helm chart into the destination directory
along with the package and it's provenance file.

The basename of these three files will be in the format `${chart_name}-${chart_version}`
unless overwritten by the parameter `target_basename`.

#### "in" Parameters

* `target_basename`: Optional parameter that can be used to change the name of the
  input files that will be written.

### out: Push an updated version of the Helm chart

#### "out" Parameters

* `chart`: *Required* Path to the tgz-archive or a folder that contains the chart to be
  uploaded. If a folder has been specified instead of a ".tgz" file, this folder will be
  packaged up prior to uploading it's contents to the ChartMuseum instance.

* `force`: Optional parameter that can be used to force the upload of the chart,
  even if the version to be uploaded does already exist on the server. Enforcement
  only works, if the ChartMuseum server has *not* been started with the
  `--disable-force-overwrite` flag, though.

* `version`: Optional parameter that can be used to override the "version" field in the
  chart's `Chart.yaml` file. If the override version is stored in a file, you can use the
  parameter `version_file` instead.

* `version_file`: Optional parameter that points to a file that contains a version string
  that should be used to override the version specified in the chart's `Chart.yaml` file.

* `sign`: Optional parameter that indicates if the chart package should be signed using a
  GPG key. If set to `true` either `key_data` or `key_file` must be specified as well.

* `key_data`: If `sign` has been set to `true`, this parameter can be used to pass the
  key to be used to sign the chart package.

* `key_file`: If `sign` has been set to `true`, this parameter can be used to pass the
  location of a file that contains the GPG key that shall be used to sign the chart
  package.

* `key_passphrase`: If `sign` has been set to `true` this parameter can be used to
  specifcy the passphrase that protects the GPG signing key to be used to sign
  the chart package.

* `dependency_update`: must be set to `true` if there are any dependencies in the
   helm chart to be uploaded. This will cause the dependencies to be fetched
   before the chart is packaged.

* `dependency_repos`: list of remote Helm Chart Repositories
  * `name`: *Required* The name of the chart repository.

  * `server_url`: *Required.* The address of the repository.

  * `basic_auth_username`: chart repository username.
    If provided, the paramter `basic_auth_password` must also be specified.

  * `basic_auth_password`: Optional chart repository password.
    If provided, the paramter `basic_auth_username` must also be specified.

  * `tls_ca_cert`: CA certificate for the Chartmuseum server

  * `tls_client_cert`: Identify HTTPS client using this SSL certificate string

  * `tls_client_key`: Identify HTTPS client using this SSL key string
