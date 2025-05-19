'use client';

import {useState, useEffect, useRef} from 'react';
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Modal,
  FlatList,
  Image,
  Alert,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {
  launchImageLibrary,
  type ImagePickerResponse,
  type Asset,
} from 'react-native-image-picker';
// @ts-ignore
import {UsbSerial} from 'react-native-usb-serial';
// Import Buffer for binary data handling
import {Buffer} from 'buffer';

// Define types
interface Command {
  id: string;
  label: string;
  value: string;
  placeholder: string;
}

interface LogEntry {
  id: string;
  message: string;
  type: string;
  timestamp: string;
  expanded: boolean;
}

interface UploadedImage {
  uri: string;
  type: string | null;
  name: string | null;
  base64: string | null;
}

interface UsbDevice {
  deviceId: string;
  vendorId: number;
  productId?: number;
  deviceName?: string;
  manufacturerName?: string;
  serialNumber?: string;
}

// Constants
const FRAME_MAGIC = 0xaa55cc33;
const TRANSFER_TIMEOUT = 15000;
const MAX_IMAGES = 6;
const IMAGE_DISPLAY_INTERVAL = 6000;


// Log types
const LOG_TYPES = {
  INFO: 'info',
  ERROR: 'error',
  SUCCESS: 'success',
  SENT: 'sent',
  WARNING: 'warning',
  TIMEOUT: 'timeout',
};

// Command definitions
const commands: Command[] = [
  {
    id: 'logoCommand',
    label: 'Display Logo',
    value: 'IDLE',
    placeholder: 'FSREAD**test.txt',
  },
  {
    id: 'textDisplayCommand',
    label: 'Text Display',
    value: 'TEXT**Main Title**Subtitle Text**Message',
    placeholder: 'TEXT**Topic**Title**Message',
  },
  {
    id: 'qrCommand',
    label: 'QR Payload',
    value: 'QR**Rs. 123.45**QRPayloadData',
    placeholder: 'QR**Amount**PayloadData',
  },
  {
    id: 'loadingCommand',
    label: 'Loading Command',
    value: 'WAIT**Rs. 560.50**Please wait...',
    placeholder: 'WAIT**Amount**Message',
  },
  {
    id: 'successCommand',
    label: 'Success Command',
    value: 'PASS**SUCCESS!**Payment successful',
    placeholder: 'PASS**Title**Message',
  },
  {
    id: 'failCommand',
    label: 'Failure Command',
    value: 'FAIL**Rs. 560.50**Payment Failed',
    placeholder: 'FAIL**Amount**Message',
  },
  {
    id: 'warnCommand',
    label: 'Warning',
    value: 'WARN**Device Not Ready**Please wait',
    placeholder: 'WARN**Title**Message',
  },
  {
    id: 'infoCommand',
    label: 'Information',
    value: 'INFO**Important**Keep device connected',
    placeholder: 'INFO**Title**Message',
  },
  {
    id: 'sleepCommand',
    label: 'Sleep Device',
    value: 'RESET',
    placeholder: 'RESET',
  },
  {
    id: 'formatCommand',
    label: 'Format Image',
    value: 'FORMAT',
    placeholder: 'FORMAT',
  },
  {id: 'wakeCommand', label: 'Wake Device', value: 'WAKE', placeholder: 'WAKE'},
  {
    id: 'screentimeCommand',
    label: 'Screen Time',
    value: 'SCREENTIME**60',
    placeholder: 'SCREENTIME**<time in seconds (30-300)>',
  },
];

const App = () => {
  // Device connection states
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [selectedBaudRate, setSelectedBaudRate] = useState<string>('115200');
  const [deviceSelectorVisible, setDeviceSelectorVisible] =
    useState<boolean>(false);
  const [availableDevices, setAvailableDevices] = useState<UsbDevice[]>([]);
  const [showTimeouts, setShowTimeouts] = useState<boolean>(false);

  // Command and image states
  const [commandValues, setCommandValues] = useState<Record<string, string>>(
    {},
  );
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [imageLoopActive, setImageLoopActive] = useState<boolean>(false);

  // Monitor states
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Refs for device connection
  const deviceRef = useRef<UsbDevice | null>(null);
  const currentImageIndexRef = useRef<number>(0);
  const imageLoopIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const transferInProgressRef = useRef<boolean>(false);
  const transferAbortedRef = useRef<boolean>(false);
  const lastTransferActivityRef = useRef<number>(Date.now());
  const transferTimeoutCheckerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize command values
  useEffect(() => {
    const initialValues: Record<string, string> = {};
    commands.forEach(cmd => {
      initialValues[cmd.id] = cmd.value;
    });
    setCommandValues(initialValues);

    // Request USB permission on mount
    requestUsbPermission();

    return () => {
      // Cleanup on unmount
      if (isDeviceConnected) {
        disconnectDevice(false).catch(console.error);
      }
      if (imageLoopIntervalRef.current) {
        clearInterval(imageLoopIntervalRef.current);
        imageLoopIntervalRef.current = null;
      }
      if (transferTimeoutCheckerRef.current) {
        clearInterval(transferTimeoutCheckerRef.current);
        transferTimeoutCheckerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request USB permission
  const requestUsbPermission = async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'USB Permission',
            message: 'This app needs access to USB devices',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          addMonitorEntry('USB permission granted', LOG_TYPES.INFO);
        } else {
          addMonitorEntry('USB permission denied', LOG_TYPES.ERROR);
        }
      }
    } catch (err: any) {
      addMonitorEntry(
        `Error requesting permission: ${err.message}`,
        LOG_TYPES.ERROR,
      );
    }
  };

  // Add entry to monitor
  const addMonitorEntry = (message: string, type = LOG_TYPES.INFO) => {
    if (type === LOG_TYPES.TIMEOUT && !showTimeouts) {return;}

    const timestamp = new Date().toLocaleTimeString();
    const newLog: LogEntry = {
      id: Date.now().toString(),
      message,
      type,
      timestamp,
      expanded: false,
    };

    setLogs(prevLogs => [newLog, ...prevLogs]);
  };

  // Clear monitor
  const clearMonitor = () => {
    setLogs([]);
    addMonitorEntry('Monitor cleared', LOG_TYPES.INFO);
  };

  // Handle connection button press
  const handleConnection = async () => {
    if (isConnecting) {return;}

    setIsConnecting(true);

    try {
      if (!isDeviceConnected) {
        await connectToDevice();
      } else {
        await disconnectDevice(true);
      }
    } catch (error: any) {
      addMonitorEntry(`Connection error: ${error.message}`, LOG_TYPES.ERROR);
    } finally {
      setIsConnecting(false);
    }
  };

  // Connect to device
  const connectToDevice = async () => {
    try {
      addMonitorEntry('Checking for CH341 devices...', LOG_TYPES.INFO);

      const devices: UsbDevice[] = await UsbSerial.list();
      const ch341Devices = devices.filter(device => device.vendorId === 0x1a86);

      if (ch341Devices.length === 0) {
        addMonitorEntry('No CH341 devices found', LOG_TYPES.ERROR);
        return false;
      } else if (ch341Devices.length === 1) {
        // Single device found, connect directly
        return await connectToSelectedDevice(ch341Devices[0]);
      } else {
        // Multiple devices found, show selector
        setAvailableDevices(ch341Devices);
        setDeviceSelectorVisible(true);
        return false;
      }
    } catch (error: any) {
      throw new Error(`Failed to list devices: ${error.message}`);
    }
  };

  // Connect to selected device
  const connectToSelectedDevice = async (
    device: UsbDevice,
  ): Promise<boolean> => {
    try {
      addMonitorEntry(
        `Attempting to open port at ${selectedBaudRate} baud...`,
        LOG_TYPES.INFO,
      );

      const baudRate = Number.parseInt(selectedBaudRate, 10);

      deviceRef.current = device;
      await UsbSerial.open(device.deviceId, {
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        dtr: true,
        rts: true,
      });

      setIsDeviceConnected(true);
      addMonitorEntry(
        `Connected to device at ${baudRate} baud`,
        LOG_TYPES.SUCCESS,
      );

      // Start reading from device
      startReading();

      return true;
    } catch (error: any) {
      deviceRef.current = null;
      throw new Error(`Connection failed: ${error.message}`);
    }
  };

  // Disconnect device
  const disconnectDevice = async (showMessages = true) => {
    if (showMessages) {addMonitorEntry('Disconnecting...', LOG_TYPES.INFO);}

    // Stop image loop if active
    if (imageLoopIntervalRef.current) {
      clearInterval(imageLoopIntervalRef.current);
      imageLoopIntervalRef.current = null;
      setImageLoopActive(false);
    }

    try {
      if (deviceRef.current) {
        await UsbSerial.close(deviceRef.current.deviceId);
        deviceRef.current = null;
      }

      setIsDeviceConnected(false);
      if (showMessages) {addMonitorEntry('Disconnected', LOG_TYPES.SUCCESS);}
    } catch (error: any) {
      addMonitorEntry(`Disconnect error: ${error.message}`, LOG_TYPES.ERROR);
      throw error;
    }
  };

  // Start reading from device
  const startReading = async () => {
    if (!deviceRef.current || !isDeviceConnected) {return;}

    let messageBuffer = '';

    try {
      UsbSerial.read(deviceRef.current.deviceId, (data: ArrayBuffer) => {
        if (!isDeviceConnected) {return;}

        // Check for ready/ack signals
        const bytes = new Uint8Array(data);
        let signalProcessed = false;

        // Check for ready signal (ASCII 'R' = 82)
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] === 82) {
            // Ready signal received
            lastTransferActivityRef.current = Date.now();
            signalProcessed = true;
            break;
          }
        }

        // Check for ack signal (ASCII 'K' = 75 or 'E' = 69)
        if (!signalProcessed) {
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 75) {
              // Success ack received
              lastTransferActivityRef.current = Date.now();
              transferInProgressRef.current = false;
              signalProcessed = true;
              break;
            } else if (bytes[i] === 69) {
              // Error ack received
              lastTransferActivityRef.current = Date.now();
              transferInProgressRef.current = false;
              transferAbortedRef.current = true;
              signalProcessed = true;
              break;
            }
          }
        }

        if (!signalProcessed) {
          // Process as text message
          const response = new TextDecoder().decode(data);
          messageBuffer += response;

          if (messageBuffer.includes('FRAME_LOST\r\n')) {
            addMonitorEntry('FRAME_LOST detected!', LOG_TYPES.ERROR);
            transferAbortedRef.current = true;
            if (transferInProgressRef.current) {abortTransfer();}
            messageBuffer = messageBuffer.replace('FRAME_LOST\r\n', '');
          }

          if (messageBuffer.includes('INVALID_CMD\r\n')) {
            addMonitorEntry('Received: INVALID_CMD', LOG_TYPES.ERROR);
            messageBuffer = messageBuffer.replace('INVALID_CMD\r\n', '');
          }

          const messages = messageBuffer.split(/\r\n|\n/);
          messageBuffer = messages.pop() || '';

          for (const msg of messages) {
            if (msg.trim()) {
              addMonitorEntry(`Received: ${msg.trim()}`, LOG_TYPES.SUCCESS);
            }
          }
        }

        lastTransferActivityRef.current = Date.now();
      });

      // Start transfer timeout checker
      startTransferTimeoutChecker();
    } catch (error: any) {
      addMonitorEntry(`Read error: ${error.message}`, LOG_TYPES.ERROR);
      await handleConnectionError(error);
    }
  };

  // Start transfer timeout checker
  const startTransferTimeoutChecker = () => {
    if (transferTimeoutCheckerRef.current) {
      clearInterval(transferTimeoutCheckerRef.current);
    }

    transferTimeoutCheckerRef.current = setInterval(() => {
      if (
        transferInProgressRef.current &&
        Date.now() - lastTransferActivityRef.current > TRANSFER_TIMEOUT
      ) {
        addMonitorEntry(
          'Transfer timeout - no device response',
          LOG_TYPES.ERROR,
        );
        abortTransfer();
      }
    }, 1000);
  };

  // Abort transfer
  const abortTransfer = async () => {
    if (transferInProgressRef.current && deviceRef.current) {
      try {
        await UsbSerial.write(deviceRef.current.deviceId, 'ABORT\n');
        addMonitorEntry('Sent abort command', LOG_TYPES.WARNING);
      } catch (error: any) {
        console.error('Abort error:', error);
      }
      transferAbortedRef.current = true;
      transferInProgressRef.current = false;
    }
  };

  // Handle connection error
  const handleConnectionError = async (error: Error): Promise<boolean> => {
    addMonitorEntry(`Connection error: ${error.message}`, LOG_TYPES.ERROR);

    try {
      await disconnectDevice(false);

      await new Promise(resolve => setTimeout(resolve, 1000));

      const success = await connectToDevice();
      if (success) {
        addMonitorEntry('Successfully recovered connection', LOG_TYPES.SUCCESS);
        return true;
      }
    } catch (recoveryError: any) {
      addMonitorEntry(
        `Failed to recover connection: ${recoveryError.message}`,
        LOG_TYPES.ERROR,
      );
    }

    return false;
  };

  // Execute command
  const executeCommand = async (commandId: string) => {
    if (!isDeviceConnected || !deviceRef.current) {
      addMonitorEntry('Please connect to device first', LOG_TYPES.ERROR);
      return;
    }

    if (imageLoopIntervalRef.current) {
      clearInterval(imageLoopIntervalRef.current);
      imageLoopIntervalRef.current = null;
      setImageLoopActive(false);
      addMonitorEntry('Image loop stopped due to new command', LOG_TYPES.INFO);
    }

    const commandValue = commandValues[commandId]?.trim();

    if (!commandValue) {
      addMonitorEntry('Command cannot be empty', LOG_TYPES.ERROR);
      return;
    }

    if (commandId === 'screentimeCommand') {
      const timeMatch = commandValue.match(/SCREENTIME\*\*(\d+)/);
      if (!timeMatch) {
        addMonitorEntry(
          'Invalid SCREENTIME format. Use SCREENTIME**<seconds>',
          LOG_TYPES.ERROR,
        );
        return;
      }
      const timeValue = Number.parseInt(timeMatch[1], 10);
      if (timeValue < 30 || timeValue > 300) {
        addMonitorEntry(
          'Screen time must be between 30 and 300 seconds',
          LOG_TYPES.ERROR,
        );
        return;
      }
    }

    try {
      await UsbSerial.write(deviceRef.current.deviceId, `${commandValue}\n`);
      addMonitorEntry(`Sent command: ${commandValue}`, LOG_TYPES.SENT);
    } catch (error: any) {
      addMonitorEntry(`Command error: ${error.message}`, LOG_TYPES.ERROR);
      await handleConnectionError(error);
    }
  };

  // Pick image from gallery
  const pickImage = async () => {
    if (!isDeviceConnected) {
      addMonitorEntry('Please connect to device first', LOG_TYPES.ERROR);
      return;
    }

    try {
      const result: ImagePickerResponse = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: MAX_IMAGES - uploadedImages.length,
        includeBase64: true,
      });

      if (result.didCancel) {return;}

      if (result.errorCode) {
        addMonitorEntry(
          `Image picker error: ${result.errorMessage}`,
          LOG_TYPES.ERROR,
        );
        return;
      }

      if (result.assets && result.assets.length > 0) {
       const newImages: UploadedImage[] = result.assets.map(
  (asset: Asset) => ({
    uri: asset.uri || '',
    type: asset.type || null,      // Convert undefined to null
    name: asset.fileName || null,  // Convert undefined to null
    base64: asset.base64 || null,  // Convert undefined to null
  }),
);

        if (uploadedImages.length + newImages.length > MAX_IMAGES) {
          addMonitorEntry(
            `Cannot add ${newImages.length} images. Maximum ${MAX_IMAGES} images allowed.`,
            LOG_TYPES.ERROR,
          );
          return;
        }

        setUploadedImages(prev => [...prev, ...newImages]);
        addMonitorEntry(
          `Added ${newImages.length} image(s). Total images: ${
            uploadedImages.length + newImages.length
          }`,
          LOG_TYPES.SUCCESS,
        );
      }
    } catch (error: any) {
      addMonitorEntry(`Error picking image: ${error.message}`, LOG_TYPES.ERROR);
    }
  };

  // Remove image
  const removeImage = (index: number) => {
    setUploadedImages(prev => {
      const newImages = [...prev];
      newImages.splice(index, 1);
      return newImages;
    });

    if (imageLoopActive && uploadedImages.length <= 1) {
      stopImageLoop();
    }
  };

  // Clear all images
  const clearAllImages = async () => {
    if (!isDeviceConnected || !deviceRef.current) {
      addMonitorEntry('Not connected to device', LOG_TYPES.ERROR);
      return;
    }

    try {
      stopImageLoop();
      setUploadedImages([]);

      await UsbSerial.write(deviceRef.current.deviceId, 'CLEAR_IMAGE\n');
      addMonitorEntry('Cleared all images', LOG_TYPES.SUCCESS);
    } catch (error: any) {
      addMonitorEntry(
        `Error clearing images: ${error.message}`,
        LOG_TYPES.ERROR,
      );
      await handleConnectionError(error);
    }
  };

  // Clear image
  const clearImage = async () => {
    if (!isDeviceConnected || !deviceRef.current) {
      addMonitorEntry('Not connected to device', LOG_TYPES.ERROR);
      return;
    }

    try {
      await UsbSerial.write(deviceRef.current.deviceId, 'CLEAR_IMAGE\n');
      addMonitorEntry('Sent clear image command', LOG_TYPES.INFO);

      await new Promise(resolve => setTimeout(resolve, 500));

      transferInProgressRef.current = false;
      transferAbortedRef.current = false;

      addMonitorEntry('Image cleared successfully', LOG_TYPES.SUCCESS);
    } catch (error: any) {
      addMonitorEntry(
        `Error clearing image: ${error.message}`,
        LOG_TYPES.ERROR,
      );
      await handleConnectionError(error);
    }
  };

  // Send image to device
  const sendImageToDevice = async (imageData: string | null) => {
    if (!isDeviceConnected || !deviceRef.current || !imageData) {
      throw new Error('Not connected to device or invalid image data');
    }

    try {
      transferInProgressRef.current = true;
      transferAbortedRef.current = false;

      await UsbSerial.write(deviceRef.current.deviceId, 'START_RTIMAGE\n');
      addMonitorEntry('Sent START_RTIMAGE', LOG_TYPES.INFO);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Convert base64 to binary
      const binaryData = Buffer.from(imageData, 'base64');

      // Create header
      const header = new ArrayBuffer(8);
      const headerView = new DataView(header);
      headerView.setUint32(0, FRAME_MAGIC, true);
      headerView.setUint32(4, binaryData.length, true);

      // Send header
      await UsbSerial.writeHexString(
        deviceRef.current.deviceId,
        Buffer.from(header).toString('hex'),
      );
      addMonitorEntry(
        `Sent image header: ${binaryData.length} bytes`,
        LOG_TYPES.INFO,
      );

      // Wait for ready signal (handled in read callback)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for ready signal'));
        }, 500);

        const checkInterval = setInterval(() => {
          if (transferAbortedRef.current) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            reject(new Error('Transfer aborted'));
          }

          // If we're no longer in transfer mode, we received a signal
          if (!transferInProgressRef.current) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      addMonitorEntry('Device ready for image data', LOG_TYPES.INFO);

      // Send image data
      if (!transferAbortedRef.current) {
        await UsbSerial.writeHexString(
          deviceRef.current.deviceId,
          binaryData.toString('hex'),
        );
        addMonitorEntry(
          `Sent image data: ${binaryData.length} bytes`,
          LOG_TYPES.INFO,
        );
      } else {
        throw new Error('Transfer aborted');
      }

      // Wait for ack signal (handled in read callback)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for acknowledgment'));
        }, 500);

        const checkInterval = setInterval(() => {
          if (transferAbortedRef.current) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            reject(new Error('Transfer aborted'));
          }

          // If we're no longer in transfer mode, we received a signal
          if (!transferInProgressRef.current) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      addMonitorEntry('Image sent successfully', LOG_TYPES.SUCCESS);
    } catch (error: any) {
      transferInProgressRef.current = false;
      throw new Error(`Failed to send image: ${error.message}`);
    }
  };

  // Start image loop
  const startImageLoop = async () => {
    if (!isDeviceConnected || uploadedImages.length === 0) {
      return;
    }

    stopImageLoop();
    currentImageIndexRef.current = 0;
    setImageLoopActive(true);

    async function displayNextImage() {
      if (!isDeviceConnected || uploadedImages.length === 0) {
        stopImageLoop();
        return;
      }

      try {
        const currentImage = uploadedImages[currentImageIndexRef.current];
        await sendImageToDevice(currentImage.base64);

        currentImageIndexRef.current =
          (currentImageIndexRef.current + 1) % uploadedImages.length;

        addMonitorEntry(
          `Displaying image ${currentImageIndexRef.current + 1} of ${
            uploadedImages.length
          }`,
          LOG_TYPES.INFO,
        );
      } catch (error: any) {
        addMonitorEntry(
          `Error in image loop: ${error.message}`,
          LOG_TYPES.ERROR,
        );
        stopImageLoop();
      }
    }

    await displayNextImage();

    imageLoopIntervalRef.current = setInterval(
      displayNextImage,
      IMAGE_DISPLAY_INTERVAL,
    );
    addMonitorEntry('Started image loop', LOG_TYPES.INFO);
  };

  // Stop image loop
  const stopImageLoop = () => {
    if (imageLoopIntervalRef.current) {
      clearInterval(imageLoopIntervalRef.current);
      imageLoopIntervalRef.current = null;
      setImageLoopActive(false);
      addMonitorEntry('Image loop stopped', LOG_TYPES.INFO);
    }
  };

  // Update command value
  const updateCommandValue = (id: string, value: string) => {
    setCommandValues(prev => ({
      ...prev,
      [id]: value,
    }));
  };

  // Render log item
  const renderLogItem = ({item}: {item: LogEntry}) => {
    const isLongMessage = item.message.length > 100;

    return (
      <View style={[styles.logItem, getLogStyle(item.type)]}>
        {isLongMessage ? (
          <TouchableOpacity onPress={() => toggleLogExpansion(item.id)}>
            <Text style={styles.logText}>
              [{item.timestamp}]{' '}
              {item.expanded
                ? item.message
                : `${item.message.substring(0, 100)}... (tap to expand)`}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.logText}>
            [{item.timestamp}] {item.message}
          </Text>
        )}
      </View>
    );
  };

  // Toggle log expansion
  const toggleLogExpansion = (id: string) => {
    setLogs(prevLogs =>
      prevLogs.map(log =>
        log.id === id ? {...log, expanded: !log.expanded} : log,
      ),
    );
  };

  // Get log style based on type
  const getLogStyle = (type: string) => {
    switch (type) {
      case LOG_TYPES.ERROR:
        return styles.logError;
      case LOG_TYPES.SUCCESS:
        return styles.logSuccess;
      case LOG_TYPES.SENT:
        return styles.logSent;
      case LOG_TYPES.WARNING:
        return styles.logWarning;
      case LOG_TYPES.TIMEOUT:
        return styles.logTimeout;
      default:
        return styles.logInfo;
    }
  };

  // Render command item
  const renderCommandItem = ({item}: {item: Command}) => (
    <View style={styles.commandContainer}>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{item.label}</Text>
        <TextInput
          style={styles.commandField}
          value={commandValues[item.id] || ''}
          onChangeText={text => updateCommandValue(item.id, text)}
          placeholder={item.placeholder}
        />
      </View>
      <TouchableOpacity
        style={[
          styles.controlButton,
          !isDeviceConnected && styles.disabledButton,
        ]}
        disabled={!isDeviceConnected}
        onPress={() => executeCommand(item.id)}>
        <Text style={styles.buttonText}>Send</Text>
      </TouchableOpacity>
    </View>
  );

  // Render image preview
  const renderImagePreview = ({
    item,
    index,
  }: {
    item: UploadedImage;
    index: number;
  }) => (
    <View style={styles.imagePreviewItem}>
      <Image source={{uri: item.uri}} style={styles.previewImage} />
      <TouchableOpacity
        style={styles.removeButton}
        onPress={() => removeImage(index)}>
        <Text style={styles.removeButtonText}>×</Text>
      </TouchableOpacity>
      <View style={styles.imageNumber}>
        <Text style={styles.imageNumberText}>#{index + 1}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#f0f0f0" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.mainWrapper}>
          {/* Control Section */}
          <View style={styles.controlSection}>
            <Text style={styles.headerText}>NiziPOS™ B20 Simulator</Text>

            {/* Device Controls */}
            <View style={styles.deviceControls}>
              <Text style={styles.deviceControlsItem}>Select Baud Rate</Text>
              <View style={styles.pickerContainer}>
                <TouchableOpacity
                  style={styles.picker}
                  onPress={() =>
                    Alert.alert('Select Baud Rate', 'Choose a baud rate', [
                      {
                        text: '9600',
                        onPress: () => setSelectedBaudRate('9600'),
                      },
                      {
                        text: '19200',
                        onPress: () => setSelectedBaudRate('19200'),
                      },
                      {
                        text: '38400',
                        onPress: () => setSelectedBaudRate('38400'),
                      },
                      {
                        text: '57600',
                        onPress: () => setSelectedBaudRate('57600'),
                      },
                      {
                        text: '115200',
                        onPress: () => setSelectedBaudRate('115200'),
                      },
                    ])
                  }>
                  <Text>{selectedBaudRate}</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  isConnecting && styles.connectingButton,
                  isDeviceConnected && styles.disconnectButton,
                ]}
                onPress={handleConnection}
                disabled={isConnecting}>
                {isConnecting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>
                    {isDeviceConnected ? 'Disconnect' : 'Connect'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Commands Section */}
            {isDeviceConnected && (
              <View style={styles.commandsSection}>
                {/* Image Upload */}
                <View style={styles.commandContainer}>
                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Image Upload</Text>
                    <TouchableOpacity
                      style={styles.dropArea}
                      onPress={pickImage}>
                      <Text style={styles.dropAreaText}>
                        {isDeviceConnected
                          ? 'Tap to select images'
                          : 'Connect to device first'}
                      </Text>
                    </TouchableOpacity>

                    {/* Image Previews */}
                    {uploadedImages.length > 0 && (
                      <View style={styles.preview}>
                        <FlatList
                          data={uploadedImages}
                          renderItem={renderImagePreview}
                          keyExtractor={(item, index) => `image-${index}`}
                          horizontal
                          style={styles.imagePreviews}
                        />
                        <View style={styles.imageControls}>
                          <TouchableOpacity
                            style={[
                              styles.controlButton,
                              (!isDeviceConnected ||
                                uploadedImages.length === 0 ||
                                imageLoopActive) &&
                                styles.disabledButton,
                            ]}
                            disabled={
                              !isDeviceConnected ||
                              uploadedImages.length === 0 ||
                              imageLoopActive
                            }
                            onPress={startImageLoop}>
                            <Text style={styles.buttonText}>Start Loop</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[
                              styles.controlButton,
                              (!isDeviceConnected || !imageLoopActive) &&
                                styles.disabledButton,
                            ]}
                            disabled={!isDeviceConnected || !imageLoopActive}
                            onPress={stopImageLoop}>
                            <Text style={styles.buttonText}>Stop Loop</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[
                              styles.controlButton,
                              (!isDeviceConnected ||
                                uploadedImages.length === 0) &&
                                styles.disabledButton,
                            ]}
                            disabled={
                              !isDeviceConnected || uploadedImages.length === 0
                            }
                            onPress={clearAllImages}>
                            <Text style={styles.buttonText}>
                              Clear All Images
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                </View>

                {/* Image Controls */}
                <View style={styles.commandContainer}>
                  <View style={styles.inputGroup}>
                    <Text style={styles.inputLabel}>Image Controls</Text>
                    <TouchableOpacity
                      style={[
                        styles.controlButton,
                        !isDeviceConnected && styles.disabledButton,
                      ]}
                      disabled={!isDeviceConnected}
                      onPress={clearImage}>
                      <Text style={styles.buttonText}>Clear Image</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Command List */}
                <FlatList
                  data={commands}
                  renderItem={renderCommandItem}
                  keyExtractor={item => item.id}
                  scrollEnabled={false}
                />
              </View>
            )}
          </View>

          {/* Monitor Section */}
          <View style={styles.monitorSection}>
            <View style={styles.monitorHeader}>
              <Text style={styles.monitorHeaderText}>Serial Logs</Text>
              <View style={styles.monitorControls}>
                <TouchableOpacity
                  style={styles.checkboxContainer}
                  onPress={() => setShowTimeouts(!showTimeouts)}>
                  <View
                    style={[
                      styles.checkbox,
                      showTimeouts && styles.checkboxChecked,
                    ]}>
                    {showTimeouts && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <Text style={styles.checkboxLabel}>Show Timeouts</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.clearButton}
                  onPress={clearMonitor}>
                  <Text style={styles.clearButtonText}>Clear</Text>
                </TouchableOpacity>
              </View>
            </View>
            <FlatList
              data={logs}
              renderItem={renderLogItem}
              keyExtractor={item => item.id}
              style={styles.monitorDisplay}
              inverted
            />
          </View>
        </View>
      </ScrollView>

      {/* Device Selector Modal */}
      <Modal
        visible={deviceSelectorVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setDeviceSelectorVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select CH341 Device</Text>
            <FlatList
              data={availableDevices}
              renderItem={({item, index}) => (
                <TouchableOpacity
                  style={styles.deviceItem}
                  onPress={async () => {
                    setDeviceSelectorVisible(false);
                    await connectToSelectedDevice(item);
                  }}>
                  <Text>Device {index + 1} (CH341)</Text>
                </TouchableOpacity>
              )}
              keyExtractor={(item, index) => `device-${index}`}
              style={styles.deviceList}
            />
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setDeviceSelectorVisible(false)}>
              <Text style={styles.buttonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f0f0',
  },
  scrollContent: {
    padding: 20,
  },
  mainWrapper: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  controlSection: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 8,
    marginBottom: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  monitorSection: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  headerText: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#333',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  deviceControls: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  deviceControlsItem: {
    marginRight: 10,
  },
  pickerContainer: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
    marginRight: 10,
  },
  picker: {
    width: 150,
    padding: 8,
  },
  actionButton: {
    padding: 8,
    paddingHorizontal: 16,
    backgroundColor: '#4CAF50',
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 100,
    height: 40,
  },
  connectingButton: {
    backgroundColor: '#ff9800',
  },
  disconnectButton: {
    backgroundColor: '#f44336',
  },
  disabledButton: {
    backgroundColor: '#cccccc',
    opacity: 0.7,
  },
  buttonText: {
    color: 'white',
    fontWeight: '500',
  },
  commandsSection: {
    marginTop: 10,
  },
  commandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
  },
  inputGroup: {
    flex: 1,
    marginRight: 10,
  },
  inputLabel: {
    fontWeight: 'bold',
    marginBottom: 5,
    color: '#333',
  },
  commandField: {
    padding: 8,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
    fontFamily: 'monospace',
  },
  controlButton: {
    padding: 8,
    paddingHorizontal: 12,
    backgroundColor: '#2196F3',
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    height: 40,
  },
  dropArea: {
    borderWidth: 3,
    borderStyle: 'dashed',
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9f9f9',
    marginBottom: 15,
  },
  dropAreaText: {
    fontSize: 14,
    color: '#666',
  },
  preview: {
    alignItems: 'center',
  },
  imagePreviews: {
    maxHeight: 120,
  },
  imagePreviewItem: {
    margin: 5,
    position: 'relative',
  },
  previewImage: {
    width: 100,
    height: 100,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
  },
  removeButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: 'red',
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  imageNumber: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderTopRightRadius: 4,
  },
  imageNumberText: {
    color: 'white',
    fontSize: 12,
  },
  imageControls: {
    flexDirection: 'row',
    marginTop: 10,
    gap: 10,
  },
  monitorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  monitorHeaderText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#444',
  },
  monitorControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 3,
    marginRight: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#2196F3',
    borderColor: '#2196F3',
  },
  checkmark: {
    color: 'white',
    fontSize: 12,
  },
  checkboxLabel: {
    fontSize: 12,
  },
  clearButton: {
    padding: 4,
    paddingHorizontal: 10,
    backgroundColor: '#2196F3',
    borderRadius: 4,
  },
  clearButtonText: {
    color: 'white',
    fontSize: 12,
  },
  monitorDisplay: {
    height: 300,
    backgroundColor: '#f8f8f8',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 4,
    padding: 15,
  },
  logItem: {
    marginBottom: 5,
    padding: 5,
    borderRadius: 4,
  },
  logText: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  logInfo: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  logError: {
    backgroundColor: 'rgba(244, 67, 54, 0.1)',
  },
  logSuccess: {
    backgroundColor: 'rgba(76, 175, 80, 0.1)',
  },
  logSent: {
    backgroundColor: 'rgba(33, 150, 243, 0.1)',
  },
  logWarning: {
    backgroundColor: 'rgba(255, 152, 0, 0.1)',
  },
  logTimeout: {
    backgroundColor: 'rgba(255, 152, 0, 0.05)',
    fontStyle: 'italic',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 8,
    width: '90%',
    maxWidth: 400,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#333',
  },
  deviceList: {
    maxHeight: 200,
  },
  deviceItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  cancelButton: {
    marginTop: 20,
    padding: 10,
    backgroundColor: '#2196F3',
    borderRadius: 4,
    alignItems: 'center',
    alignSelf: 'flex-end',
  },
});

export default App;
