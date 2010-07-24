package com.danga.camli;

import java.util.ArrayList;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Parcelable;
import android.os.RemoteException;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;

public class CamliActivity extends Activity {
    private static final String TAG = "CamliActivity";
    private static final int MENU_SETTINGS = 1;

    private IUploadService serviceStub = null;

    private final ArrayList<Uri> pendingUrisToUpload = new ArrayList<Uri>();

    private IStatusCallback statusCallback = new IStatusCallback.Stub() {
        public void logToClient(String stuff) throws RemoteException {
            Log.d(TAG, "From service: " + stuff);
        }

        public void onUploadStatusChange(boolean uploading)
                throws RemoteException {
            Log.d(TAG, "upload status change: " + uploading);
        }
    };

    private final ServiceConnection serviceConnection = new ServiceConnection() {

        public void onServiceConnected(ComponentName name, IBinder service) {
            serviceStub = IUploadService.Stub.asInterface(service);
            Log.d(TAG, "Service connected");
            try {
                serviceStub.registerCallback(statusCallback);
                // Drain the queue from before the service was connected.
                for (Uri uri : pendingUrisToUpload) {
                    startDownloadOfUri(uri);
                }
                pendingUrisToUpload.clear();
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }

        public void onServiceDisconnected(ComponentName name) {
            Log.d(TAG, "Service disconnected");
            serviceStub = null;
        };
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // TODO Auto-generated method stub
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        // TODO Auto-generated method stub
        super.onDestroy();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        super.onCreateOptionsMenu(menu);
        menu.add(Menu.NONE, MENU_SETTINGS, 0, "Settings");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
        case MENU_SETTINGS:
            SettingsActivity.show(this);
            break;
        }
        return true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            if (serviceStub != null)
                serviceStub.unregisterCallback(statusCallback);
        } catch (RemoteException e) {
            // Ignore.
        }
        if (serviceConnection != null) {
            unbindService(serviceConnection);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();

        bindService(new Intent(this, UploadService.class), serviceConnection,
                Context.BIND_AUTO_CREATE);

        Intent intent = getIntent();
        String action = intent.getAction();
        Log.d(TAG, "onResume; action=" + action);
        if (Intent.ACTION_SEND.equals(action)) {
            handleSend(intent);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            handleSendMultiple(intent);
        }
    }

    private void handleSendMultiple(Intent intent) {
        ArrayList<Parcelable> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        for (Parcelable p : items) {
            if (!(p instanceof Uri)) {
                Log.d(TAG, "uh, unknown thing " + p);
                continue;
            }
            startDownloadOfUri((Uri) p);
        }
    }

    private void handleSend(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) {
            Log.w(TAG, "expected extras in handleSend");
            return;
        }

        extras.keySet(); // unparcel
        Log.d(TAG, "handleSend; extras=" + extras);

        Object streamValue = extras.get("android.intent.extra.STREAM");
        if (!(streamValue instanceof Uri)) {
            Log.w(TAG, "Expected URI for STREAM; got: " + streamValue);
            return;
        }

        Uri uri = (Uri) streamValue;
        startDownloadOfUri(uri);
    }

    private void startDownloadOfUri(final Uri uri) {
        Log.d(TAG, "startDownload of " + uri);
        if (serviceStub == null) {
            Log.d(TAG, "serviceStub is null in startDownloadOfUri, enqueing");
            pendingUrisToUpload.add(uri);
            return;
        }
        new AsyncTask<Void, Void, Void>() {
            @Override
            protected Void doInBackground(Void... unused) {
                try {
                    serviceStub.enqueueUpload(uri);
                } catch (RemoteException e) {
                    Log.d(TAG, "failure to enqueue upload", e);
                }
                return null; // void
            }
        }.execute();
    }
}