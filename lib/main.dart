import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'package:webview_flutter/webview_flutter.dart';

const webAppUrl =
    'https://script.google.com/macros/s/AKfycbwCeluwp3H610JmC2KMxVJWeQdIxzeW4F6E9WiuZGjMdzMoId3ZifqGu8OboWtSejjHkw/exec';

final notifications = FlutterLocalNotificationsPlugin();
final notificationAction = ValueNotifier<String?>(null);

const int reminder900 = 900;
const int reminder905 = 905;
const int reminder917 = 917;
const int snoozeBase = 2000;

const String categoryId = 'FRIDAY_DINNER_REMINDER';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  tzdata.initializeTimeZones();
  tz.setLocalLocation(tz.getLocation('Asia/Karachi'));

  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  final iosInit = DarwinInitializationSettings(
    notificationCategories: <DarwinNotificationCategory>[
      DarwinNotificationCategory(
        categoryId,
        actions: <DarwinNotificationAction>[
          DarwinNotificationAction.plain(
            'OPEN_DINNER',
            'Select Dish',
            options: <DarwinNotificationActionOption>{
              DarwinNotificationActionOption.foreground,
            },
          ),
          DarwinNotificationAction.plain(
            'SNOOZE_4',
            '4 min',
            options: <DarwinNotificationActionOption>{
              DarwinNotificationActionOption.foreground,
            },
          ),
          DarwinNotificationAction.plain(
            'SNOOZE_7',
            '7 min',
            options: <DarwinNotificationActionOption>{
              DarwinNotificationActionOption.foreground,
            },
          ),
          DarwinNotificationAction.plain(
            'SNOOZE_10',
            '10 min',
            options: <DarwinNotificationActionOption>{
              DarwinNotificationActionOption.foreground,
            },
          ),
        ],
      ),
    ],
  );

  await notifications.initialize(
    settings: InitializationSettings(android: androidInit, iOS: iosInit),
    onDidReceiveNotificationResponse: (response) {
      notificationAction.value = notificationAction.value = response.actionId?.isEmpty ?? true
          ? 'OPEN_DINNER'
          : response.actionId;
    },
  );

  if (Platform.isAndroid) {
    final android = notifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
    await android?.requestNotificationsPermission();
    await android?.requestExactAlarmsPermission();
  } else if (Platform.isIOS) {
    final ios = notifications
        .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin>();
    await ios?.requestPermissions(alert: true, badge: true, sound: true);
  }

  await FridayReminderScheduler.scheduleUpcomingFriday();
  runApp(const FridayDinnerApp());
}

class FridayDinnerApp extends StatelessWidget {
  const FridayDinnerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Reliable Punching – Friday Dinner',
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF123D6A),
      ),
      home: const FridayDinnerHome(),
    );
  }
}

class FridayDinnerHome extends StatefulWidget {
  const FridayDinnerHome({super.key});

  @override
  State<FridayDinnerHome> createState() => _FridayDinnerHomeState();
}

class _FridayDinnerHomeState extends State<FridayDinnerHome> {
  late final WebViewController _controller;
  double _progress = 0;

  @override
  void initState() {
    super.initState();

    notificationAction.addListener(_consumeNotificationAction);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (Platform.isAndroid) {
        _checkForAndroidUpdate();
      }
    });

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'FridayDinnerBridge',
        onMessageReceived: (JavaScriptMessage message) async {
          try {
            final data = jsonDecode(message.message) as Map<String, dynamic>;
            if (data['type'] == 'order_saved') {
              await FridayReminderScheduler.orderCompleted();
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text(
                      'Order saved ✓ Remaining Friday reminders cancelled.',
                    ),
                  ),
                );
              }
            }
          } catch (_) {
            // Ignore malformed bridge messages; web ordering must keep working.
          }
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (mounted) setState(() => _progress = progress / 100);
          },
        ),
      )
      ..loadRequest(Uri.parse(webAppUrl));
  }

  @override
  void dispose() {
    notificationAction.removeListener(_consumeNotificationAction);
    super.dispose();
  }

  void _consumeNotificationAction() {
    final action = notificationAction.value;
    if (action == null) return;
    notificationAction.value = null;
    _handleNotificationActionId(action);
  }

  Future<void> _handleNotificationActionId(String actionId) async {
    switch (actionId) {
      case 'SNOOZE_4':
        await FridayReminderScheduler.snooze(const Duration(minutes: 4));
        break;
      case 'SNOOZE_7':
        await FridayReminderScheduler.snooze(const Duration(minutes: 7));
        break;
      case 'SNOOZE_10':
        await FridayReminderScheduler.snooze(const Duration(minutes: 10));
        break;
      default:
        break;
    }

    await _controller.loadRequest(Uri.parse(webAppUrl));
  }

  Future<void> _checkForAndroidUpdate() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final currentBuild = int.tryParse(info.buildNumber) ?? 1;
      final configUri = Uri.parse('$webAppUrl?action=mobileConfig');
      final response = await http.get(configUri).timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return;

      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final android = (data['android'] as Map?)?.cast<String, dynamic>();
      if (android == null) return;

      final latestBuild = (android['versionCode'] as num?)?.toInt() ?? currentBuild;
      final latestName = (android['versionName'] ?? '').toString();
      final apkUrl = (android['apkUrl'] ?? '').toString().trim();
      final force = android['force'] == true;

      if (latestBuild <= currentBuild || apkUrl.isEmpty || !mounted) return;

      await showDialog<void>(
        context: context,
        barrierDismissible: !force,
        builder: (context) => PopScope(
          canPop: !force,
          child: AlertDialog(
            title: const Text('App Update Available'),
            content: Text(
              latestName.isEmpty
                  ? 'Friday Dinner app ka naya version available hai.'
                  : 'Friday Dinner app version $latestName available hai.',
            ),
            actions: [
              if (!force)
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Later'),
                ),
              FilledButton(
                onPressed: () async {
                  final uri = Uri.parse(apkUrl);
                  if (await canLaunchUrl(uri)) {
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  }
                  if (context.mounted && !force) {
                    Navigator.of(context).pop();
                  }
                },
                child: const Text('Update Now'),
              ),
            ],
          ),
        ),
      );
    } catch (_) {
      // Update check must never block dinner ordering.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 48,
        title: const Text(
          'Friday Dinner',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: () => _controller.reload(),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_progress < 1)
            LinearProgressIndicator(value: _progress == 0 ? null : _progress),
          Expanded(child: WebViewWidget(controller: _controller)),
        ],
      ),
    );
  }
}

class FridayReminderScheduler {
  static const _androidDetails = AndroidNotificationDetails(
    'friday_dinner_alarm',
    'Friday Dinner Reminders',
    channelDescription: 'Friday dinner dish selection reminders',
    importance: Importance.max,
    priority: Priority.max,
    category: AndroidNotificationCategory.alarm,
    audioAttributesUsage: AudioAttributesUsage.alarm,
    playSound: true,
    sound: RawResourceAndroidNotificationSound('friday_reminder_android'),
    actions: <AndroidNotificationAction>[
      AndroidNotificationAction(
        'OPEN_DINNER',
        'Select Dish',
        showsUserInterface: true,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        'SNOOZE_4',
        '4 min',
        showsUserInterface: true,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        'SNOOZE_7',
        '7 min',
        showsUserInterface: true,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        'SNOOZE_10',
        '10 min',
        showsUserInterface: true,
        cancelNotification: true,
      ),
    ],
  );

  static const _iosDetails = DarwinNotificationDetails(
    categoryIdentifier: categoryId,
    sound: 'friday_reminder_ios.wav',
    presentAlert: true,
    presentSound: true,
  );

  static const _details = NotificationDetails(
    android: _androidDetails,
    iOS: _iosDetails,
  );

  static tz.TZDateTime _nextFridayAt(int hour, int minute,
      {bool forceFollowingFriday = false}) {
    final now = tz.TZDateTime.now(tz.local);
    var days = (DateTime.friday - now.weekday + 7) % 7;
    if (forceFollowingFriday && days == 0) days = 7;

    var date = tz.TZDateTime(
      tz.local,
      now.year,
      now.month,
      now.day + days,
      hour,
      minute,
    );

    if (!forceFollowingFriday && !date.isAfter(now)) {
      date = date.add(const Duration(days: 7));
    }
    return date;
  }

  static Future<void> scheduleUpcomingFriday() async {
    await _schedule(
      reminder900,
      _nextFridayAt(21, 0),
      'Friday Dinner Reminder 🍽️',
      'Apna name select karein, PIN enter karein aur dinner dish save kar dein.',
    );
    await _schedule(
      reminder905,
      _nextFridayAt(21, 5),
      'Dinner dish abhi pending hai',
      'Agar busy hain to 4, 7 ya 10 minute ka reminder choose kar sakte hain.',
    );
    await _schedule(
      reminder917,
      _nextFridayAt(21, 17),
      'LAST Friday Dinner reminder',
      'Order window 9:26 PM par close hogi. Ab 9 minutes remaining hain.',
    );
  }

  static Future<void> _schedule(
    int id,
    tz.TZDateTime date,
    String title,
    String body,
  ) async {
    await notifications.zonedSchedule(
      id: id,
      title: title,
      body: body,
      scheduledDate: date,
      notificationDetails: _details,
      androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
      payload: webAppUrl,
    );
  }

  static Future<void> snooze(Duration duration) async {
    final now = tz.TZDateTime.now(tz.local);
    final target = now.add(duration);

    // Friday cutoff is 9:26 PM. Never schedule a snooze beyond that time.
    final cutoff = tz.TZDateTime(
      tz.local,
      now.year,
      now.month,
      now.day,
      21,
      26,
    );

    if (now.weekday != DateTime.friday || !target.isBefore(cutoff)) {
      return;
    }

    await _schedule(
      snoozeBase + target.minute,
      target,
      'Friday Dinner – Snooze complete',
      'Ab apni dish select karke “Save My Dish” press kar dein.',
    );
  }

  static Future<void> orderCompleted() async {
    await notifications.cancel(id: reminder900);
    await notifications.cancel(id: reminder905);
    await notifications.cancel(id: reminder917);

    // Cancel possible snoozes created this Friday.
    for (var i = snoozeBase; i < snoozeBase + 60; i++) {
      await notifications.cancel(id: i);
    }

    // Prepare next Friday immediately, so reminders still work even if the app
    // isn't opened again during the week.
    await _schedule(
      reminder900,
      _nextFridayAt(21, 0, forceFollowingFriday: true),
      'Friday Dinner Reminder 🍽️',
      'Apna name select karein, PIN enter karein aur dinner dish save kar dein.',
    );
    await _schedule(
      reminder905,
      _nextFridayAt(21, 5, forceFollowingFriday: true),
      'Dinner dish abhi pending hai',
      'Agar busy hain to 4, 7 ya 10 minute ka reminder choose kar sakte hain.',
    );
    await _schedule(
      reminder917,
      _nextFridayAt(21, 17, forceFollowingFriday: true),
      'LAST Friday Dinner reminder',
      'Order window 9:26 PM par close hogi. Ab 9 minutes remaining hain.',
    );
  }
}
