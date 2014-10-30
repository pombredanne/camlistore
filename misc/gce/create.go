package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"camlistore.org/third_party/code.google.com/p/goauth2/oauth"
	compute "camlistore.org/third_party/code.google.com/p/google-api-go-client/compute/v1"
	storage "camlistore.org/third_party/code.google.com/p/google-api-go-client/storage/v1"
)

var (
	proj     = flag.String("project", "", "name of Project")
	zone     = flag.String("zone", "us-central1-a", "GCE zone")
	mach     = flag.String("machinetype", "g1-small", "e.g. n1-standard-1, f1-micro, g1-small")
	instName = flag.String("instance_name", "camlistore-server", "Name of VM instance.")
	sshPub   = flag.String("ssh_public_key", "", "ssh public key file to authorize. Can modify later in Google's web UI anyway.")
	help     = flag.Bool("help", false, "print a few hints to help with getting started.")
)

const (
	clientIdDat       = "client-id.dat"
	clientSecretDat   = "client-secret.dat"
	helpCreateProject = "Create new project: go to https://console.developers.google.com to create a new Project."
	helpEnableAuth    = `Enable authentication: in your project console, navigate to "APIs and auth", "Credentials", click on "Create new Client ID"¸ and pick "Installed application", with type "Other". Copy the CLIENT ID to ` + clientIdDat + `, and the CLIENT SECRET to ` + clientSecretDat
	helpEnableAPIs    = `Enable the project APIs: in your project console, navigate to "APIs and auth", "APIs". In the list, enable "Google Cloud Storage", "Google Cloud Storage JSON API", and "Google Compute Engine".`
)

func readFile(v string) string {
	slurp, err := ioutil.ReadFile(v)
	if err != nil {
		if os.IsNotExist(err) {
			log.Fatalf("%v does not exist.\n%s", v, helpEnableAuth)
		}
		log.Fatalf("Error reading %s: %v", v, err)
	}
	return strings.TrimSpace(string(slurp))
}

func printHelp() {
	for _, v := range []string{helpCreateProject, helpEnableAuth, helpEnableAPIs} {
		fmt.Printf("%v\n", v)
	}
}

func main() {
	flag.Parse()
	if *help {
		printHelp()
		return
	}
	if *proj == "" {
		log.Printf("Missing --project flag.")
		printHelp()
		return
	}
	prefix := "https://www.googleapis.com/compute/v1/projects/" + *proj
	imageURL := "https://www.googleapis.com/compute/v1/projects/coreos-cloud/global/images/coreos-alpha-402-2-0-v20140807"
	machType := prefix + "/zones/" + *zone + "/machineTypes/" + *mach

	config := &oauth.Config{
		// The client-id and secret should be for an "Installed Application" when using
		// the CLI. Later we'll use a web application with a callback.
		ClientId:     readFile(clientIdDat),
		ClientSecret: readFile(clientSecretDat),
		Scope: strings.Join([]string{
			compute.DevstorageFull_controlScope,
			compute.ComputeScope,
			"https://www.googleapis.com/auth/sqlservice",
			"https://www.googleapis.com/auth/sqlservice.admin",
		}, " "),
		AuthURL:     "https://accounts.google.com/o/oauth2/auth",
		TokenURL:    "https://accounts.google.com/o/oauth2/token",
		RedirectURL: "urn:ietf:wg:oauth:2.0:oob",
	}

	tr := &oauth.Transport{
		Config: config,
	}

	tokenCache := oauth.CacheFile(*proj + "-token.dat")
	token, err := tokenCache.Token()
	if err != nil {
		log.Printf("Error getting token from %s: %v", string(tokenCache), err)
		log.Printf("Get auth code from %v", config.AuthCodeURL("my-state"))
		os.Stdout.Write([]byte("\nEnter auth code: "))
		sc := bufio.NewScanner(os.Stdin)
		sc.Scan()
		authCode := strings.TrimSpace(sc.Text())
		token, err = tr.Exchange(authCode)
		if err != nil {
			log.Fatalf("Error exchanging auth code for a token: %v", err)
		}
		tokenCache.PutToken(token)
	}

	tr.Token = token
	oauthClient := &http.Client{Transport: tr}
	computeService, _ := compute.New(oauthClient)
	storageService, _ := storage.New(oauthClient)

	cloudConfig := `#cloud-config
write_files:
  - path: /var/lib/camlistore/tmp/README
    permissions: 0644
    content: |
      This is the Camlistore /tmp directory.
  - path: /var/lib/camlistore/mysql/README
    permissions: 0644
    content: |
      This is the Camlistore MySQL data directory.
coreos:
  units:
    - name: cam-journal-gatewayd.service
      content: |
        [Unit]
        Description=Journal Gateway Service
        Requires=cam-journal-gatewayd.socket
        
        [Service]
        ExecStart=/usr/lib/systemd/systemd-journal-gatewayd
        User=systemd-journal-gateway
        Group=systemd-journal-gateway
        SupplementaryGroups=systemd-journal
        PrivateTmp=yes
        PrivateDevices=yes
        PrivateNetwork=yes
        ProtectSystem=full
        ProtectHome=yes
        
        [Install]
        Also=cam-journal-gatewayd.socket
    - name: cam-journal-gatewayd.socket
      command: start
      content: |
        [Unit]
        Description=Journal Gateway Service Socket
        
        [Socket]
        ListenStream=/run/camjournald.sock
        
        [Install]
        WantedBy=sockets.target
    - name: mysql.service
      command: start
      content: |
        [Unit]
        Description=MySQL
        After=docker.service
        Requires=docker.service
        
        [Service]
        ExecStartPre=/usr/bin/docker run --rm -v /opt/bin:/opt/bin ibuildthecloud/systemd-docker
        ExecStart=/opt/bin/systemd-docker run --rm --name %n -v /var/lib/camlistore/mysql:/mysql -e INNODB_BUFFER_POOL_SIZE=NNN camlistore/mysql
        RestartSec=1s
        Restart=always
        Type=notify
        NotifyAccess=all
        
        [Install]
        WantedBy=multi-user.target
    - name: camlistored.service
      command: start
      content: |
        [Unit]
        Description=Camlistore
        After=docker.service
        Requires=docker.service mysql.service
        
        [Service]
        ExecStartPre=/usr/bin/docker run --rm -v /opt/bin:/opt/bin ibuildthecloud/systemd-docker
        ExecStart=/opt/bin/systemd-docker run --rm -p 80:80 -p 443:443 --name %n -v /run/camjournald.sock:/run/camjournald.sock -v /var/lib/camlistore/tmp:/tmp --link=mysql.service:mysqldb camlistore/camlistored
        RestartSec=1s
        Restart=always
        Type=notify
        NotifyAccess=all
        
        [Install]
        WantedBy=multi-user.target
`
	cloudConfig = strings.Replace(cloudConfig, "INNODB_BUFFER_POOL_SIZE=NNN", "INNODB_BUFFER_POOL_SIZE="+strconv.Itoa(innodbBufferPoolSize(*mach)), -1)

	const maxCloudConfig = 32 << 10 // per compute API docs
	if len(cloudConfig) > maxCloudConfig {
		log.Fatalf("cloud config length of %d bytes is over %d byte limit", len(cloudConfig), maxCloudConfig)
	}
	if *sshPub != "" {
		key := strings.TrimSpace(readFile(*sshPub))
		cloudConfig += fmt.Sprintf("\nssh_authorized_keys:\n    - %s\n", key)
	}

	blobBucket := *proj + "-camlistore-blobs"
	configBucket := *proj + "-camlistore-config"
	needBucket := map[string]bool{
		blobBucket:   true,
		configBucket: true,
	}

	buckets, err := storageService.Buckets.List(*proj).Do()
	if err != nil {
		log.Fatalf("Error listing buckets: %v", err)
	}
	for _, it := range buckets.Items {
		delete(needBucket, it.Name)
	}
	if len(needBucket) > 0 {
		log.Printf("Need to create buckets: %v", needBucket)
		var waitBucket sync.WaitGroup
		for name := range needBucket {
			name := name
			waitBucket.Add(1)
			go func() {
				defer waitBucket.Done()
				log.Printf("Creating bucket %s", name)
				b, err := storageService.Buckets.Insert(*proj, &storage.Bucket{
					Id:   name,
					Name: name,
				}).Do()
				if err != nil {
					log.Fatalf("Error creating bucket %s: %v", name, err)
				}
				log.Printf("Created bucket %s: %+v", name, b)
			}()
		}
		waitBucket.Wait()
	}

	instance := &compute.Instance{
		Name:        *instName,
		Description: "Camlistore server",
		MachineType: machType,
		Disks: []*compute.AttachedDisk{
			{
				AutoDelete: true,
				Boot:       true,
				Type:       "PERSISTENT",
				InitializeParams: &compute.AttachedDiskInitializeParams{
					DiskName:    *instName + "-coreos-stateless-pd",
					SourceImage: imageURL,
				},
			},
		},
		Tags: &compute.Tags{
			Items: []string{"http-server", "https-server"},
		},
		Metadata: &compute.Metadata{
			Items: []*compute.MetadataItems{
				{
					Key:   "camlistore-username",
					Value: "test",
				},
				{
					Key:   "camlistore-password",
					Value: "insecure", // TODO: this won't be cleartext later
				},
				{
					Key:   "camlistore-blob-bucket",
					Value: "gs://" + blobBucket,
				},
				{
					Key:   "camlistore-config-bucket",
					Value: "gs://" + configBucket,
				},
				{
					Key:   "user-data",
					Value: cloudConfig,
				},
			},
		},
		NetworkInterfaces: []*compute.NetworkInterface{
			&compute.NetworkInterface{
				AccessConfigs: []*compute.AccessConfig{
					&compute.AccessConfig{
						Type: "ONE_TO_ONE_NAT",
						Name: "External NAT",
					},
				},
				Network: prefix + "/global/networks/default",
			},
		},
		ServiceAccounts: []*compute.ServiceAccount{
			{
				Email: "default",
				Scopes: []string{
					compute.DevstorageFull_controlScope,
					compute.ComputeScope,
					"https://www.googleapis.com/auth/sqlservice",
					"https://www.googleapis.com/auth/sqlservice.admin",
				},
			},
		},
	}
	const localMySQL = false // later
	if localMySQL {
		instance.Disks = append(instance.Disks, &compute.AttachedDisk{
			AutoDelete: false,
			Boot:       false,
			Type:       "PERSISTENT",
			InitializeParams: &compute.AttachedDiskInitializeParams{
				DiskName:   "camlistore-mysql-index-pd",
				DiskSizeGb: 4,
			},
		})
	}

	log.Printf("Creating instance...")
	op, err := computeService.Instances.Insert(*proj, *zone, instance).Do()
	if err != nil {
		log.Fatalf("Failed to create instance: %v", err)
	}
	opName := op.Name
	log.Printf("Created. Waiting on operation %v", opName)
OpLoop:
	for {
		time.Sleep(2 * time.Second)
		op, err := computeService.ZoneOperations.Get(*proj, *zone, opName).Do()
		if err != nil {
			log.Fatalf("Failed to get op %s: %v", opName, err)
		}
		switch op.Status {
		case "PENDING", "RUNNING":
			log.Printf("Waiting on operation %v", opName)
			continue
		case "DONE":
			if op.Error != nil {
				for _, operr := range op.Error.Errors {
					log.Printf("Error: %+v", operr)
				}
				log.Fatalf("Failed to start.")
			}
			log.Printf("Success. %+v", op)
			break OpLoop
		default:
			log.Fatalf("Unknown status %q: %+v", op.Status, op)
		}
	}

	inst, err := computeService.Instances.Get(*proj, *zone, *instName).Do()
	if err != nil {
		log.Fatalf("Error getting instance after creation: %v", err)
	}
	ij, _ := json.MarshalIndent(inst, "", "    ")
	log.Printf("Instance: %s", ij)
}

// returns the MySQL InnoDB buffer pool size (in bytes) as a function
// of the GCE machine type.
func innodbBufferPoolSize(machType string) int {
	// Totally arbitrary. We don't need much here because
	// camlistored slurps this all into its RAM on start-up
	// anyway. So this is all prety overkill and more than the
	// 8MB default.
	switch machType {
	case "f1-micro":
		return 32 << 20
	case "g1-small":
		return 64 << 20
	default:
		return 128 << 20
	}
}
