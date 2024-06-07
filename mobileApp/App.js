import * as React from "react";
import { NavigationContainer } from "@react-navigation/native";
import {
  createStackNavigator,
  TransitionPresets,
} from "@react-navigation/stack";
import HomeScreen from "./HomeScreen";
import MyBedroomScreen from "./MyBedroomScreen";

const Stack = createStackNavigator();

const App = () => {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: "#434343" },
          headerTintColor: "#f4f4f9",
          headerTitleStyle: { fontWeight: "bold" },
          ...TransitionPresets.SlideFromRightIOS,
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: "Home" }}
        />
        <Stack.Screen
          name="MyBedroom"
          component={MyBedroomScreen}
          options={{ title: "My Bedroom" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

export default App;
